import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { KnowledgeBatch, KnowledgeStore, KnowledgeVersion } from "../domain/knowledge.js";
import { validateKnowledge, validateRecords, type KnowledgeLookup } from "./knowledge-validation.js";
import { accessGated, activeAccess } from "./access.js";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/** Knowledge scope of a folder: "<organization>/<repository>" when it has access, else the folder itself. */
export function knowledgeScope(root: string): string {
  const access = activeAccess(root);
  if (access && accessGated()) return `${access.organization.id}/${access.repository_id}`;
  let path = resolve(root);
  if (existsSync(path)) path = realpathSync.native(path);
  if (process.platform === "win32") path = path.toLowerCase();
  return digest(path);
}

/** The repository's SQLite knowledge database. */
export function knowledgePath(root: string): string {
  return join(homedir(), ".kurtel", "knowledge", ...knowledgeScope(root).split("/"), "store.db");
}
/** A store.json from earlier versions: imported once, then kept as store.json.imported. */
const legacyPath = (root: string) => join(dirname(knowledgePath(root)), "store.json");

export function emptyBatch(): KnowledgeBatch {
  return { sources: [], events: [], versions: [], relations: [] };
}

// One row per immutable record, in order; other columns index it for targeted reads.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT, protocol TEXT, knowledge_id TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, knowledge_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE (knowledge_id, version));
CREATE TABLE IF NOT EXISTS relations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, from_id TEXT NOT NULL, to_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS heads (knowledge_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS zones (knowledge_id TEXT NOT NULL, zone TEXT NOT NULL, PRIMARY KEY (knowledge_id, zone));
CREATE INDEX IF NOT EXISTS events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS events_knowledge ON events (knowledge_id);
CREATE INDEX IF NOT EXISTS events_protocol ON events (protocol);
CREATE INDEX IF NOT EXISTS heads_state ON heads (state);
CREATE INDEX IF NOT EXISTS zones_zone ON zones (zone);
CREATE INDEX IF NOT EXISTS relations_from ON relations (from_id);
CREATE INDEX IF NOT EXISTS relations_to ON relations (to_id);
`;
/** How long a writer waits for another. */
const BUSY_TIMEOUT_MS = Number(process.env.KURTEL_STORE_BUSY_MS ?? 5000);
const connections = new Map<string, Database.Database>();

/** Closes this process's connections (tests, restore). */
export function closeKnowledge(): void {
  for (const db of connections.values()) db.close();
  connections.clear();
}

function open(root: string, create: boolean): Database.Database | null {
  const path = knowledgePath(root);
  const cached = connections.get(path);
  if (cached) return cached;
  if (!existsSync(path) && !create && !existsSync(legacyPath(root))) return null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(SCHEMA);
    migrateSchema(db);
    const scope = knowledgeScope(root);
    const stored = (db.prepare("SELECT value FROM meta WHERE key = 'scope'").get() as { value: string } | undefined)?.value;
    if (stored && stored !== scope) throw new Error("Invalid knowledge store: schema or repository scope mismatch");
    if (!stored) {
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('scope', ?), ('schema_version', '2'), ('revision', '0')").run(scope);
        importLegacy(db, root, scope);
      }).immediate();
    }
  } catch (error) { db.close(); throw error; }
  connections.set(path, db);
  return db;
}

/** Imports and validates a store.json, then keeps it aside. */
function importLegacy(db: Database.Database, root: string, scope: string): void {
  const legacy = legacyPath(root);
  if (!existsSync(legacy)) return;
  // A broken store is never replaced by an empty one.
  const store: unknown = JSON.parse(readFileSync(legacy, "utf8"));
  validateKnowledge(store, scope);
  insertBatch(db, store);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(store.revision));
  renameSync(legacy, `${legacy}.imported`);
}

/** Schema 2: indexes, full-text search, stored vectors and a memory revision. */
function migrateSchema(db: Database.Database): void {
  if ((db.pragma("user_version", { simple: true }) as number) >= 2) return;
  db.transaction(() => {
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
    if (!columns("events").has("version_id")) db.exec("ALTER TABLE events ADD COLUMN version_id TEXT; ALTER TABLE events ADD COLUMN target_id TEXT;");
    if (!columns("heads").has("kind")) db.exec("ALTER TABLE heads ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
    db.exec(`CREATE INDEX IF NOT EXISTS events_version ON events (version_id);
      CREATE INDEX IF NOT EXISTS events_target ON events (target_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_text USING fts5 (knowledge_id UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS vectors (knowledge_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, table_id TEXT NOT NULL, data BLOB NOT NULL);`);
    const setEvent = db.prepare("UPDATE events SET version_id = ?, target_id = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, json FROM events").all() as { id: string; json: string }[]) {
      const d = eventData(JSON.parse(row.json).content);
      setEvent.run(textOf(d.version_id), textOf(d.event_id) ?? textOf(d.relation_id), row.id);
    }
    const setKind = db.prepare("UPDATE heads SET kind = ? WHERE knowledge_id = ?"), text = db.prepare("INSERT INTO knowledge_text (rowid, knowledge_id, content) VALUES (?, ?, ?)");
    db.exec("DELETE FROM knowledge_text");
    for (const row of db.prepare("SELECT h.rowid, h.knowledge_id, v.json FROM heads h JOIN versions v ON v.id = h.version_id").all() as { rowid: number; knowledge_id: string; json: string }[]) {
      const v = JSON.parse(row.json) as KnowledgeVersion;
      setKind.run(v.kind, row.knowledge_id); text.run(row.rowid, row.knowledge_id, v.content);
    }
    const revision = (db.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: string } | undefined)?.value ?? "0";
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('memory_revision', ?)").run(revision);
    db.pragma("user_version = 2");
  }).immediate();
}
const textOf = (value: unknown) => typeof value === "string" ? value : null;

const eventData = (content: string): { protocol?: string; knowledge_id?: string; version_id?: string; event_id?: string; relation_id?: string } => {
  if (!content.startsWith("{")) return {};
  try { const d = JSON.parse(content); return d && typeof d === "object" ? d : {}; } catch { return {}; }
};

/** Whether memory changed, not only captures. */
function insertBatch(db: Database.Database, batch: KnowledgeBatch): boolean {
  migrateSchema(db);
  const source = db.prepare("INSERT INTO sources (id, json) VALUES (?, ?)");
  const event = db.prepare("INSERT INTO events (id, session_id, protocol, knowledge_id, version_id, target_id, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const version = db.prepare("INSERT INTO versions (id, knowledge_id, version, json) VALUES (?, ?, ?, ?)");
  const relation = db.prepare("INSERT INTO relations (id, from_id, to_id, json) VALUES (?, ?, ?, ?)");
  const head = db.prepare("INSERT INTO heads (knowledge_id, version_id, version, state, kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT (knowledge_id) DO UPDATE SET version_id = excluded.version_id, version = excluded.version, state = excluded.state, kind = excluded.kind WHERE excluded.version > heads.version");
  const current = db.prepare("SELECT rowid, version_id FROM heads WHERE knowledge_id = ?");
  const dropText = db.prepare("DELETE FROM knowledge_text WHERE rowid = ?"), addText = db.prepare("INSERT INTO knowledge_text (rowid, knowledge_id, content) VALUES (?, ?, ?)");
  let memory = batch.versions.length > 0 || batch.relations.length > 0;
  const zone = db.prepare("INSERT OR IGNORE INTO zones (knowledge_id, zone) VALUES (?, ?)");
  for (const s of batch.sources) source.run(s.id, JSON.stringify(s));
  for (const e of batch.events) {
    const d = eventData(e.content);
    event.run(e.id, e.session_id, textOf(d.protocol), textOf(d.knowledge_id), textOf(d.version_id), textOf(d.event_id) ?? textOf(d.relation_id), JSON.stringify(e));
    if (typeof d.protocol === "string" && d.protocol.startsWith("kurtel-") && d.protocol !== "kurtel-usage-v1") memory = true;
  }
  for (const v of batch.versions) {
    version.run(v.id, v.knowledge_id, v.version, JSON.stringify(v));
    head.run(v.knowledge_id, v.id, v.version, v.state, v.kind);
    const now = current.get(v.knowledge_id) as { rowid: number; version_id: string };
    if (now.version_id === v.id) { dropText.run(now.rowid); addText.run(now.rowid, v.knowledge_id, v.content); }
    for (const z of v.zones) zone.run(v.knowledge_id, z);
  }
  for (const r of batch.relations) relation.run(r.id, r.from.id, r.to.id, JSON.stringify(r));
  if (memory) db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_revision'").run();
  return memory;
}

function load(db: Database.Database): KnowledgeStore {
  const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
  const rows = (table: string) => (db.prepare(`SELECT json FROM ${table} ORDER BY seq`).all() as { json: string }[]).map(r => JSON.parse(r.json));
  return { schema_version: 2, scope: meta.scope, revision: Number(meta.revision), sources: rows("sources"), events: rows("events"), versions: rows("versions"), relations: rows("relations") };
}

export function readKnowledge(root: string): KnowledgeStore {
  const db = open(root, false);
  if (!db) return { schema_version: 2, scope: knowledgeScope(root), revision: 0, ...emptyBatch() };
  return load(db);
}

/** Current version of every knowledge. */
export function currentVersions(root: string, state?: KnowledgeVersion["state"]): KnowledgeVersion[] {
  const db = open(root, false);
  if (!db) return [];
  const rows = state
    ? db.prepare("SELECT v.json FROM heads h JOIN versions v ON v.id = h.version_id WHERE h.state = ? ORDER BY v.seq").all(state)
    : db.prepare("SELECT v.json FROM heads h JOIN versions v ON v.id = h.version_id ORDER BY v.seq").all();
  return (rows as { json: string }[]).map(r => JSON.parse(r.json));
}

// Refuse when another writer holds the legacy lock.
function assertNoExternalWriter(root: string): void {
  const lock = knowledgePath(root) + ".lock";
  if (existsSync(lock)) throw new Error(`Knowledge store is locked: ${lock}. Retry; after a crash, verify no writer is running before removing the lock.`);
}

function runWrite<T>(db: Database.Database, work: () => T): T {
  try { return db.transaction(work).immediate(); }
  catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error(`Knowledge store is locked by another Kurtel process (waited ${BUSY_TIMEOUT_MS} ms). Retry.`);
    throw error;
  }
}

/** The only exception to immutability: the content of captures may be erased. */
export function redactKnowledge(root: string, redact: (current: KnowledgeStore) => { sources: Map<string, string>; events: Map<string, string> }): number {
  if (!existsSync(knowledgePath(root)) && !existsSync(legacyPath(root))) return 0;
  assertNoExternalWriter(root);
  const db = open(root, true)!;
  return writeFromSnapshot(db, () => db.transaction(() => load(db))(), current => {
    const changes = redact(structuredClone(current));
    const sources = current.sources.flatMap(source => {
      const content = changes.sources.get(source.id);
      if (content === undefined || content === source.content) return [];
      if (!source.id.startsWith("capture:")) throw new Error(`Only captured text can be erased: ${source.id}`);
      return [{ ...source, content }];
    });
    const events = current.events.flatMap(event => {
      const content = changes.events.get(event.id);
      if (content === undefined || content === event.content) return [];
      if (!event.id.startsWith("capture-event:") && !event.id.startsWith("error:")) throw new Error(`Only captured text can be erased: ${event.id}`);
      return [{ ...event, content }];
    });
    return () => {
      if (!sources.length && !events.length) return 0;
      const touched = { ...emptyBatch(), sources, events };
      validateRecords(touched, lookupIn(db, touched));
      const updateSource = db.prepare("UPDATE sources SET json = ? WHERE id = ?"), updateEvent = db.prepare("UPDATE events SET json = ? WHERE id = ?");
      for (const s of sources) updateSource.run(JSON.stringify(s), s.id);
      for (const e of events) updateEvent.run(JSON.stringify(e), e.id);
      db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
      return sources.length + events.length;
    };
  });
}

const revisionIn = (db: Database.Database) => Number((db.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: string }).value);
const RETRY = Symbol("retry");
/** Optimistic write: prepared on a snapshot, applied if nothing changed meanwhile; after three collisions, inside the transaction. */
function writeFromSnapshot<T>(db: Database.Database, snapshot: () => KnowledgeStore, work: (current: KnowledgeStore) => () => T): T {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = snapshot();
    const apply = work(current);
    const result = runWrite(db, () => revisionIn(db) === current.revision ? apply() : RETRY);
    if (result !== RETRY) return result as T;
  }
  return runWrite(db, () => work(snapshot())());
}

/** Resolves references among new records, then in the database. */
function lookupIn(db: Database.Database, added: KnowledgeBatch): KnowledgeLookup {
  const sources = new Set(added.sources.map(s => s.id)), events = new Map(added.events.map(e => [e.id, e])), versions = new Set(added.versions.map(v => v.id));
  const source = db.prepare("SELECT 1 FROM sources WHERE id = ?"), event = db.prepare("SELECT json FROM events WHERE id = ?"), version = db.prepare("SELECT 1 FROM versions WHERE id = ?");
  const head = db.prepare("SELECT version_id AS id, version FROM heads WHERE knowledge_id = ?");
  return {
    hasSource: id => sources.has(id) || source.get(id) !== undefined,
    hasEvent: id => events.has(id) || event.get(id) !== undefined,
    hasVersion: id => versions.has(id) || version.get(id) !== undefined,
    event: id => events.get(id) ?? ((row => row ? JSON.parse(row.json) : undefined)(event.get(id) as { json: string } | undefined)),
    head: id => head.get(id) as { id: string; version: number } | undefined,
  };
}

/** Appends immutable records in one transaction. `prepare` sees the whole store, or only `scope`. */
export function appendKnowledge(
  root: string,
  prepare: (current: KnowledgeStore) => KnowledgeBatch,
  expectedRevision?: number,
  scope?: KnowledgeQuery,
): KnowledgeStore {
  assertNoExternalWriter(root);
  const db = open(root, true)!;
  return writeFromSnapshot(db, () => db.transaction(() => scope ? loadFor(db, scope) : load(db))(), current => {
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error("Knowledge revision conflict");
    const batch = prepare(structuredClone(current));
    return () => insertPrepared(db, current, batch);
  });
}

function insertPrepared(db: Database.Database, current: KnowledgeStore, batch: KnowledgeBatch): KnowledgeStore {
  {
    const next = structuredClone(current), added = emptyBatch();
    const stored = { sources: db.prepare("SELECT json FROM sources WHERE id = ?"), events: db.prepare("SELECT json FROM events WHERE id = ?"), versions: db.prepare("SELECT json FROM versions WHERE id = ?"), relations: db.prepare("SELECT json FROM relations WHERE id = ?") };
    for (const key of ["sources", "events", "versions", "relations"] as const) {
      const records = next[key] as { id: string }[];
      const known = new Map(records.map(record => [record.id, record]));
      for (const record of batch[key] as { id: string }[]) {
        const previous = known.get(record.id) ?? ((row => row ? JSON.parse(row.json) : undefined)(stored[key].get(record.id) as { json: string } | undefined));
        if (previous) {
          if (canonicalJSON(previous) !== canonicalJSON(record)) throw new Error(`Immutable record conflict: ${record.id}`);
          continue;
        }
        records.push(record); known.set(record.id, record);
        (added[key] as { id: string }[]).push(record);
      }
    }
    if (!added.sources.length && !added.events.length && !added.versions.length && !added.relations.length) return current;
    next.revision++;
    validateRecords(added, lookupIn(db, added));
    insertBatch(db, added);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(next.revision));
    return next;
  }
}

/** Changes only when memory does. */
export function memoryRevisionOf(root: string): string {
  const db = open(root, false);
  return "m" + ((db?.prepare("SELECT value FROM meta WHERE key = 'memory_revision'").get() as { value: string } | undefined)?.value ?? "0");
}

export interface KnowledgeQuery {
  /** Repository-relative task paths: knowledge on these files or their directories. */
  paths?: string[];
  /** Words of the task: full-text match on current contents. */
  words?: string[];
  /** Knowledge ids found by other means (meaning vectors). */
  knowledgeIds?: string[];
  /** Version ids cited explicitly. */
  versionIds?: string[];
  /** Current session: all its events, to judge what is suspended. */
  session?: string;
  /** Hops through relations between versions (investigation mode). */
  depth?: number;
  /** At most this many full-text matches. */
  limit?: number;
}

/** The part of the store that may concern one task, with what is needed to assess it. */
export function readKnowledgeFor(root: string, query: KnowledgeQuery): KnowledgeStore {
  const db = open(root, false);
  if (db === null) return { schema_version: 2, scope: knowledgeScope(root), revision: 0, ...emptyBatch() };
  return db.transaction(() => loadFor(db, query))();
}

function loadFor(db: Database.Database, query: KnowledgeQuery): KnowledgeStore {
  {
    const list = (values: Iterable<string>) => JSON.stringify([...new Set(values)]);
    const ids = (sql: string, ...params: unknown[]) => (db.prepare(sql).all(...params) as { id: string }[]).map(r => r.id);
    const knowledge = new Set<string>(query.knowledgeIds ?? []);
    // The task's files and every directory above them.
    const prefixes = new Set<string>();
    for (const path of query.paths ?? []) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i).join("/"); prefixes.add(p); prefixes.add(p + "/"); }
    }
    if (prefixes.size) for (const id of ids("SELECT DISTINCT knowledge_id AS id FROM zones WHERE zone IN (SELECT value FROM json_each(?))", list(prefixes))) knowledge.add(id);
    if (query.paths?.length) for (const id of ids("SELECT knowledge_id AS id FROM heads WHERE kind = 'constraint' AND NOT EXISTS (SELECT 1 FROM zones z WHERE z.knowledge_id = heads.knowledge_id)")) knowledge.add(id);
    const words = [...new Set((query.words ?? []).filter(w => /^[\p{L}\p{N}_]{3,}$/u.test(w)))].slice(0, 32);
    if (words.length) for (const id of ids("SELECT knowledge_id AS id FROM knowledge_text WHERE knowledge_text MATCH ? ORDER BY rank LIMIT ?", words.map(w => `"${w}"`).join(" OR "), query.limit ?? 200)) knowledge.add(id);
    if (query.versionIds?.length) for (const id of ids("SELECT knowledge_id AS id FROM versions WHERE id IN (SELECT value FROM json_each(?))", list(query.versionIds))) knowledge.add(id);

    const rows = <T>(sql: string, ...params: unknown[]) => (db.prepare(sql).all(...params) as { json: string }[]).map(r => JSON.parse(r.json) as T);
    type Version = KnowledgeStore["versions"][number]; type Relation = KnowledgeStore["relations"][number]; type Event = KnowledgeStore["events"][number];
    let versions: Version[] = [], relations: Relation[] = [];
    for (let hop = 0; ; hop++) {
      versions = rows<Version>("SELECT json FROM versions WHERE knowledge_id IN (SELECT value FROM json_each(?)) ORDER BY seq", list(knowledge));
      const loaded = new Set(versions.map(v => v.id));
      relations = rows<Relation>("SELECT json FROM relations WHERE from_id IN (SELECT value FROM json_each(@ids)) OR to_id IN (SELECT value FROM json_each(@ids)) ORDER BY seq", { ids: list(loaded) });
      if (hop >= (query.depth ?? 1)) break;
      const linked = relations.flatMap(r => [r.from, r.to]).filter(r => r.type === "version" && loaded.has(r.id) === false).map(r => r.id);
      if (linked.length === 0) break;
      const before = knowledge.size;
      for (const id of ids("SELECT knowledge_id AS id FROM versions WHERE id IN (SELECT value FROM json_each(?))", list(linked))) knowledge.add(id);
      if (knowledge.size === before) break;
    }
    const versionIds = versions.map(v => v.id), relationIds = relations.map(r => r.id);
    const eventIds = new Set([...versions.flatMap(v => v.event_ids), ...relations.flatMap(r => [r.from, r.to]).filter(r => r.type === "event").map(r => r.id)]);
    const events = rows<Event>(`SELECT json FROM events WHERE id IN (SELECT value FROM json_each(@events)) OR knowledge_id IN (SELECT value FROM json_each(@knowledge))
      OR version_id IN (SELECT value FROM json_each(@versions)) OR (@session IS NOT NULL AND session_id = @session) ORDER BY seq`, { events: list(eventIds), knowledge: list(knowledge), versions: list(versionIds), session: query.session ?? null });
    const seen = new Set(events.map(e => e.id));
    const targets = rows<Event>("SELECT json FROM events WHERE target_id IN (SELECT value FROM json_each(?)) ORDER BY seq", list([...seen, ...relationIds])).filter(e => seen.has(e.id) === false);
    const allEvents = [...events, ...targets];
    const sourceIds = [...versions.flatMap(v => v.source_ids), ...relations.flatMap(r => [...r.source_ids, ...(r.to.type === "source" ? [r.to.id] : [])]), ...allEvents.flatMap(e => e.source_ids)];
    const sources = rows<KnowledgeStore["sources"][number]>("SELECT json FROM sources WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq", list(sourceIds));
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
    return { schema_version: 2 as const, scope: meta.scope, revision: Number(meta.revision), sources, events: allEvents, versions, relations };
  }
}

/** Stored vectors of active knowledge for one vector table. */
export function* storedVectors(root: string, tableId: string): Generator<{ knowledge_id: string; vector: Int8Array }> {
  const db = open(root, false);
  if (db === null) return;
  for (const r of db.prepare("SELECT v.knowledge_id, v.data FROM vectors v JOIN heads h ON h.knowledge_id = v.knowledge_id AND h.version_id = v.version_id WHERE v.table_id = ? AND h.state = 'active' AND length(v.data) > 0").iterate(tableId) as Iterable<{ knowledge_id: string; data: Buffer }>)
    yield { knowledge_id: r.knowledge_id, vector: new Int8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) };
}

/** Active knowledge without a vector yet, at most `limit`. */
export function contentsWithoutVector(root: string, tableId: string, limit: number): { knowledge_id: string; version_id: string; content: string }[] {
  const db = open(root, false);
  if (db === null) return [];
  return (db.prepare(`SELECT h.knowledge_id, h.version_id, v.json FROM heads h JOIN versions v ON v.id = h.version_id LEFT JOIN vectors x ON x.knowledge_id = h.knowledge_id
    WHERE h.state = 'active' AND (x.knowledge_id IS NULL OR x.version_id <> h.version_id OR x.table_id <> ?) LIMIT ?`).all(tableId, limit) as { knowledge_id: string; version_id: string; json: string }[])
    .map(r => ({ knowledge_id: r.knowledge_id, version_id: r.version_id, content: (JSON.parse(r.json) as KnowledgeVersion).content }));
}

/** Saves vectors; an empty one means "no known word". */
export function saveVectors(root: string, tableId: string, rows: { knowledge_id: string; version_id: string; vector: Int8Array | null }[]): void {
  const db = open(root, false);
  if (db === null || rows.length === 0) return;
  const put = db.prepare("INSERT INTO vectors (knowledge_id, version_id, table_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (knowledge_id) DO UPDATE SET version_id = excluded.version_id, table_id = excluded.table_id, data = excluded.data");
  db.transaction(() => { for (const r of rows) put.run(r.knowledge_id, r.version_id, tableId, r.vector ? Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength) : Buffer.alloc(0)); })();
}
