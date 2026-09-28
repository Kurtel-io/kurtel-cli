// Shared knowledge: local operations are pushed to kurtel.io, which builds the shared version chains; teammates'
// are pulled back. Conversations never leave the machine.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { KnowledgeBatch, KnowledgeEvent, KnowledgeStore, KnowledgeVersion } from "../domain/knowledge.js";
import { appendKnowledge, closeKnowledge, digest, emptyBatch, knowledgePath, readKnowledge } from "../storage/knowledge.js";
import { acquireLock, releaseLock } from "../storage/lock.js";
import { policyFetch } from "../security/network.js";
import { apiUrl, loadConfig } from "../lib/config.js";
import { repoSlug } from "../repository/git.js";
import { memoryEnabled, repoActivated } from "../storage/state.js";
import { CONFIRMATION, CORRECTION, automaticEnabled, sessionTurns, turnVerdict, type Turn } from "./automatic.js";
import { ANCHOR, anchorKnowledge, knowledgeOrigin } from "./visibility.js";
import { backgroundUpkeep } from "./upkeep.js";
import { accessGated, activeAccess, denyAccess, withholdMemory, type AccessReason, type OrganizationRef } from "../storage/access.js";
import { originRemote } from "../repository/remote.js";

export interface SharedConfig { enabled: boolean; endpoint: string; repo: string; cursor: number; pushed: string[]; adopted: string[] }
type Operation = Record<string, unknown> & { type: "learn" | "transition" | "event" };
interface Pulled { seq: number; type: "version" | "event"; record: Record<string, any> }

const configPath = (root: string) => join(dirname(knowledgePath(root)), "shared.json");
const lockPath = (root: string) => join(dirname(knowledgePath(root)), "shared.lock");
const SYNC_LOCK_STALE_MS = 5 * 60_000;
const PUSH_CHUNK = 100;
const ID = /^[\w:.-]{1,200}$/;
const zoneOk = (z: string) => z.length > 0 && z.length <= 200 && !/[\\\x00-\x1f]/.test(z) && !/^(?:[A-Za-z]:|\/)/.test(z) && !z.split("/").includes("..");

export function sharedConfig(root: string): SharedConfig | null {
  try { return JSON.parse(readFileSync(configPath(root), "utf8")); } catch { return null; }
}
function saveConfig(root: string, config: SharedConfig): void {
  const file = configPath(root); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config) + "\n", { mode: 0o600 }); renameSync(temporary, file);
}
export const defaultSharedEndpoint = () => `${apiUrl()}/api/memory/knowledge`;

export function enableSharing(root: string, endpoint = defaultSharedEndpoint()): SharedConfig {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS, or HTTP on loopback, without credentials/query/fragment");
  const previous = sharedConfig(root);
  // Another server or repository starts from zero.
  const same = previous && previous.endpoint === endpoint && previous.repo === repoSlug(root);
  const config = { enabled: true, endpoint, repo: repoSlug(root), cursor: same ? previous.cursor : 0, pushed: same ? previous.pushed : [], adopted: same ? previous.adopted : [] };
  saveConfig(root, config); return config;
}
export function disableSharing(root: string): void {
  const config = sharedConfig(root);
  if (config) saveConfig(root, { ...config, enabled: false });
}
/** Always on for a declared repository; enterprise deployments opt in. */
function cloudSharing(root: string): SharedConfig | null {
  if (!accessGated() || !activeAccess(root)) return null;
  const existing = sharedConfig(root);
  if (existing?.endpoint === defaultSharedEndpoint()) return existing.enabled ? existing : null;
  const config = { enabled: true, endpoint: defaultSharedEndpoint(), repo: originRemote(root)!, cursor: 0, pushed: [], adopted: [] };
  saveConfig(root, config);
  return config;
}
const sharingActive = (root: string) => repoActivated(root) && memoryEnabled(root) && (accessGated() ? !!cloudSharing(root) : !!sharedConfig(root)?.enabled);
const credential = () => process.env.KURTEL_SHARED_TOKEN ?? loadConfig().token;

/** The server refused access. */
class AccessRefused extends Error {
  constructor(readonly reason: AccessReason, readonly organizations?: OrganizationRef[]) { super(`shared_access_${reason}`); }
}

async function call(root: string, config: SharedConfig, body: object): Promise<any> {
  const token = credential();
  if (!token) throw new Error("Sign in with kurtel login to share knowledge");
  const url = new URL(config.endpoint);
  const purpose = url.origin === new URL(apiUrl()).origin ? "cloud" : "engine";
  const access = activeAccess(root);
  const where = purpose === "cloud" && access ? { remote: access.remote, organization: access.organization.id } : {};
  const response = await policyFetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ protocol: 1, repo: config.repo, ...where, ...body }) }, purpose);
  if (purpose === "cloud" && [401, 403, 409].includes(response.status)) {
    let refusal: { error?: string; organizations?: OrganizationRef[] } = {};
    try { refusal = await response.json() as typeof refusal; } catch { /* no body */ }
    const reason = response.status === 401 ? "not_signed_in" : (["no_access", "not_declared", "organization_required"].includes(refusal.error ?? "") ? refusal.error : null) as AccessReason | null;
    if (reason) throw new AccessRefused(reason, refusal.organizations);
    // Memory no longer included: graph only, access and local data kept.
    if (refusal.error === "memory_not_enabled") { withholdMemory(root); throw new Error("shared_memory_not_enabled"); }
  }
  if (!response.ok) throw new Error(`shared_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 5_000_000) throw new Error("Shared response too large");
  const result = JSON.parse(raw);
  if (result.protocol !== 1) throw new Error("Invalid shared protocol");
  return result;
}

const data = (event: KnowledgeEvent) => { try { return JSON.parse(event.content); } catch { return null; } };
const shareableEvent = (event: KnowledgeEvent) => [CONFIRMATION, CORRECTION, ANCHOR].includes(data(event)?.protocol);
const shareableVersion = (v: KnowledgeVersion) => v.kind !== "legacy_pattern" && v.content.length <= 1200 && v.zones.length <= 8 && v.zones.every(zoneOk) && ID.test(v.id) && ID.test(v.knowledge_id);

/** Where and in which session knowledge was learned. */
function origin(store: KnowledgeStore, v: KnowledgeVersion) {
  const o = knowledgeOrigin(store, v);
  const session = v.event_ids.map(id => store.events.find(e => e.id === id)).find(e => e?.id.startsWith("capture-event:"))?.session_id ?? null;
  return { branch: o?.branch ?? null, commit: o?.commit ?? null, session };
}

/** Local operations the server has not seen yet, in order. */
export function pendingOperations(store: KnowledgeStore, config: SharedConfig, unjudged: Set<string> = new Set()): { operations: Operation[]; ids: string[] } {
  const done = new Set([...config.pushed, ...config.adopted]);
  const events = new Set(store.events.filter(shareableEvent).map(e => e.id));
  const operations: Operation[] = [], ids: string[] = [];
  const shared = new Set<string>();
  // Unsent knowledge waits for its turn to be judged; once sent, all its changes are sent.
  const heads = new Map<string, KnowledgeVersion>();
  for (const v of store.versions) if ((heads.get(v.knowledge_id)?.version ?? 0) < v.version) heads.set(v.knowledge_id, v);
  const held = new Set(store.versions.filter(v => v.version === 1 && !done.has(v.id) && (unjudged.has(v.knowledge_id) || heads.get(v.knowledge_id)!.state !== "active")).map(v => v.knowledge_id));
  for (const v of store.versions) {
    if (!shareableVersion(v) || held.has(v.knowledge_id)) continue;
    shared.add(v.id);
    if (done.has(v.id)) continue;
    const eventIds = v.event_ids.filter(id => events.has(id) && ID.test(id)).slice(0, 16);
    if (v.version === 1) {
      const o = origin(store, v);
      operations.push({ type: "learn", knowledge_id: v.knowledge_id, version: { id: v.id, kind: v.kind, state: v.state, content: v.content, zones: v.zones, recorded_at: v.recorded_at }, origin: { branch: o.branch, commit: o.commit?.slice(0, 64) ?? null, session: o.session, learned_at: v.recorded_at }, event_ids: eventIds });
    } else {
      if (!v.previous_version_id || !shared.has(v.previous_version_id)) continue;
      operations.push({ type: "transition", knowledge_id: v.knowledge_id, from_version_id: v.previous_version_id, version: { id: v.id, state: v.state, content: v.content, zones: v.zones }, event_ids: eventIds });
    }
    ids.push(v.id);
  }
  for (const e of store.events) {
    if (!events.has(e.id) || done.has(e.id) || !ID.test(e.id)) continue;
    operations.push({ type: "event", event: { id: e.id, recorded_at: e.recorded_at, data: data(e) } });
    ids.push(e.id);
  }
  return { operations, ids };
}

/** Knowledge from an agent's turn is shared once the user's next message did not correct it. The user's own words need no verdict. */
export function unjudgedKnowledge(root: string, store: KnowledgeStore): Set<string> {
  const out = new Set<string>(), turns = new Map<string, Turn[]>();
  const turnOf = (session: string, eventId: string) => {
    if (!turns.has(session)) turns.set(session, sessionTurns(store, session));
    return turns.get(session)!.find(t => t.agentEventIds.has(eventId));
  };
  // A later confirmation verifies it too.
  const confirmed = new Set(store.events.map(e => { try { const d = JSON.parse(e.content); return d.protocol === CONFIRMATION ? d.knowledge_id : null; } catch { return null; } }).filter(Boolean));
  for (const v of store.versions) {
    if (v.version !== 1 || v.origin || confirmed.has(v.knowledge_id)) continue;
    for (const eventId of v.event_ids) {
      const session = store.events.find(e => e.id === eventId)?.session_id;
      const turn = session && eventId.startsWith("capture-event:") ? turnOf(session, eventId) : undefined;
      if (!turn || !automaticEnabled(root, session!)) continue;
      const verdict = turnVerdict(store, session!, turn.user.id);
      if (!verdict || verdict === "session_end" || verdict === "silence") { out.add(v.knowledge_id); break; }
    }
  }
  return out;
}

/** Adopts pulled records; the server's chain wins. */
export function adoptRecords(current: KnowledgeStore, repo: string, records: Pulled[]): { batch: KnowledgeBatch; adopted: string[] } {
  const batch = emptyBatch(), adopted: string[] = [], now = new Date().toISOString();
  const eventIds = new Set(current.events.map(e => e.id)), versionIds = new Set(current.versions.map(v => v.id));
  const heads = new Map<string, KnowledgeVersion>();
  for (const v of current.versions) if ((heads.get(v.knowledge_id)?.version ?? 0) < v.version) heads.set(v.knowledge_id, v);
  const sourceFor = (actor: string) => {
    const id = `shared:${digest(`${repo}:${actor}`)}`;
    if (!current.sources.some(s => s.id === id) && !batch.sources.some(s => s.id === id)) batch.sources.push({ id, kind: "document", reference: `kurtel-shared/${repo}/${actor}`, revision: null, recorded_at: now, content: JSON.stringify({ protocol: "kurtel-shared-v1", repo, actor }) });
    return id;
  };
  for (const { type, record } of records) {
    if (type === "event") {
      if (eventIds.has(record.id)) continue;
      batch.events.push({ id: record.id, kind: "observation", source_ids: [sourceFor(record.actor)], actor: record.actor, session_id: record.data.session ?? null, occurred_at: null, recorded_at: record.recorded_at, content: JSON.stringify(record.data) });
      eventIds.add(record.id); adopted.push(record.id);
      continue;
    }
    if (versionIds.has(record.id)) continue;
    const head = heads.get(record.knowledge_id);
    if (head && head.state === record.state && head.content === record.content && JSON.stringify(head.zones) === JSON.stringify(record.zones)) continue;
    const version: KnowledgeVersion = { id: record.id, knowledge_id: record.knowledge_id, version: (head?.version ?? 0) + 1, previous_version_id: head?.id ?? null,
      kind: record.kind, state: record.state, content: record.content, zones: record.zones, source_ids: head ? head.source_ids : [sourceFor(record.author ?? record.actor)],
      event_ids: (record.event_ids as string[]).filter(id => eventIds.has(id)), recorded_at: record.recorded_at ?? now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null,
      ...(record.origin?.learned_at ? { origin: { branch: record.origin.branch ?? null, commit: record.origin.commit ?? null, learned_at: record.origin.learned_at } } : {}) };
    batch.versions.push(version); heads.set(version.knowledge_id, version); versionIds.add(version.id); adopted.push(version.id);
  }
  return { batch, adopted };
}

/** Push, then pull. Skipped while another synchronization runs. */
export async function syncShared(root: string): Promise<{ pushed: number; pulled: number } | null> {
  if (!sharingActive(root)) return null;
  const lock = lockPath(root);
  mkdirSync(dirname(lock), { recursive: true });
  const fd = acquireLock(lock, SYNC_LOCK_STALE_MS);
  if (fd === null) return null;
  let refused: AccessRefused | null = null;
  try {
    return await synchronize(root);
  } catch (error) {
    if (!(error instanceof AccessRefused)) throw error;
    refused = error;
    return null;
  } finally {
    releaseLock(lock, fd);
    // Refused: stop here, after releasing the lock and database (Windows keeps open files).
    if (refused) { closeKnowledge(); denyAccess(root, refused.reason, refused.organizations); }
  }
}

async function synchronize(root: string): Promise<{ pushed: number; pulled: number }> {
  {
    let config = sharedConfig(root)!;
    try { anchorKnowledge(root); } catch { /* Anchoring retries at the next synchronization. */ }
    const store = readKnowledge(root);
    const { operations, ids } = pendingOperations(store, config, unjudgedKnowledge(root, store));
    // Always asked: each synchronization also checks access.
    for (let i = 0; i < operations.length; i += PUSH_CHUNK) {
      await call(root, config, { action: "push", operations: operations.slice(i, i + PUSH_CHUNK) });
      config = { ...config, pushed: [...config.pushed, ...ids.slice(i, i + PUSH_CHUNK)] };
      saveConfig(root, config);
    }
    let pulled = 0;
    for (let more = true; more;) {
      const page = await call(root, config, { action: "pull", since: config.cursor });
      if (!Array.isArray(page.records) || !Number.isSafeInteger(page.cursor)) throw new Error("Invalid shared page");
      let adopted: string[] = [];
      appendKnowledge(root, current => { const r = adoptRecords(current, config.repo, page.records); adopted = r.adopted; return r.batch; });
      pulled += adopted.length;
      config = { ...config, cursor: page.cursor, adopted: [...config.adopted, ...adopted] };
      saveConfig(root, config);
      more = page.more === true;
    }
    if (pulled) backgroundUpkeep(root);
    return { pushed: operations.length, pulled };
  }
}

export function shareInBackground(root: string): void {
  if (!sharingActive(root)) return;
  const child = spawn(process.execPath, [process.argv[1], "memory", "share", "now"], { cwd: root, env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", () => {}); child.unref();
}
