// Knowledge is visible on the branch it was learned on, or once one of its anchor commits (the author's commit or
// the pull request's merge) is in HEAD's history. Otherwise hidden, never deleted.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KnowledgeOrigin, KnowledgeStore, KnowledgeVersion } from "../domain/knowledge.js";
import { appendKnowledge, digest, emptyBatch, knowledgePath, readKnowledge } from "../storage/knowledge.js";
import { currentBranch, hasUncommittedChanges, headCommit, headCommitTime, isAncestor } from "../repository/git.js";

export const ANCHOR = "kurtel-anchor-v1";
const json = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

// Lookups built once per store object.
interface Index { first: Map<string, KnowledgeVersion>; events: Map<string, KnowledgeStore["events"][number]>; sources: Map<string, KnowledgeStore["sources"][number]> }
const indexes = new WeakMap<KnowledgeStore, Index>();
function indexOf(store: KnowledgeStore): Index {
  let index = indexes.get(store);
  if (!index) {
    index = { first: new Map(store.versions.filter(v => v.version === 1).map(v => [v.knowledge_id, v])), events: new Map(store.events.map(e => [e.id, e])), sources: new Map(store.sources.map(s => [s.id, s])) };
    indexes.set(store, index);
  }
  return index;
}

/** Where knowledge was learned. */
export function knowledgeOrigin(store: KnowledgeStore, v: KnowledgeVersion): KnowledgeOrigin | null {
  if (v.origin) return v.origin;
  const index = indexOf(store);
  const first = index.first.get(v.knowledge_id) ?? v;
  for (const eventId of first.event_ids) {
    const event = index.events.get(eventId);
    const source = event && index.sources.get(event.source_ids[0]);
    if (!source?.id.startsWith("capture:")) continue;
    const meta = json(source.content ?? "{}");
    if (meta?.branch) return { branch: meta.branch, commit: meta.commit ?? null, learned_at: first.recorded_at };
  }
  return null;
}

export function anchorsOf(store: KnowledgeStore): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of store.events) {
    if (e.kind !== "observation" || !e.content.includes(ANCHOR)) continue;
    const d = json(e.content);
    if (d?.protocol === ANCHOR && typeof d.knowledge_id === "string" && typeof d.commit === "string") out.set(d.knowledge_id, [...(out.get(d.knowledge_id) ?? []), d.commit]);
  }
  return out;
}

const heads = (store: KnowledgeStore) => {
  const out = new Map<string, KnowledgeVersion>();
  for (const v of store.versions) if ((out.get(v.knowledge_id)?.version ?? 0) < v.version) out.set(v.knowledge_id, v);
  return out;
};
const learnedHere = (store: KnowledgeStore, v: KnowledgeVersion) => !indexOf(store).first.get(v.knowledge_id)?.origin;

/** Anchors knowledge once its author committed it on the same branch. Returns how many. */
export function anchorKnowledge(root: string): number {
  const store = readKnowledge(root), branch = currentBranch(root), anchors = anchorsOf(store);
  const pending = [...heads(store).values()].filter(v => v.state === "active" && !anchors.has(v.knowledge_id) && learnedHere(store, v)).flatMap(v => {
    const origin = knowledgeOrigin(store, v);
    return origin?.branch === branch ? [{ v, origin }] : [];
  });
  if (!pending.length) return 0;
  const head = headCommit(root), time = headCommitTime(root);
  if (head === "unknown" || !time) return 0;
  const ready = pending.filter(({ v, origin }) => Date.parse(time) > Date.parse(origin.learned_at) && head !== origin.commit && !hasUncommittedChanges(root, v.zones));
  if (!ready.length) return 0;
  let added = 0;
  appendKnowledge(root, current => {
    const batch = emptyBatch(), now = new Date().toISOString();
    for (const { v } of ready) {
      const id = `anchor:${digest(`${v.knowledge_id}:${head}`)}`;
      if (current.events.some(e => e.id === id)) continue;
      batch.events.push({ id, kind: "observation", source_ids: [v.source_ids[0]], actor: null, session_id: null, occurred_at: null, recorded_at: now, content: JSON.stringify({ protocol: ANCHOR, knowledge_id: v.knowledge_id, commit: head, branch, via: "commit" }) });
      added++;
    }
    return batch;
  });
  return added;
}

// Ancestry cached per HEAD.
const cachePath = (root: string) => join(dirname(knowledgePath(root)), "context", "ancestry.json");
function ancestryCache(root: string, head: string): { head: string; results: Record<string, boolean> } {
  try { const c = JSON.parse(readFileSync(cachePath(root), "utf8")); if (c.head === head) return c; } catch { /* none yet */ }
  return { head, results: {} };
}
function saveCache(root: string, cache: { head: string; results: Record<string, boolean> }): void {
  try {
    const file = cachePath(root); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 }); renameSync(temporary, file);
  } catch { /* A cache only. */ }
}

/** Versions whose code is not on this checkout. */
export function hiddenVersions(root: string, store: KnowledgeStore): Set<string> {
  const branch = currentBranch(root), anchors = anchorsOf(store), hidden = new Set<string>();
  const head = headCommit(root), cache = ancestryCache(root, head);
  let dirty = false;
  const reachable = (commit: string) => {
    if (!(commit in cache.results)) { cache.results[commit] = isAncestor(root, commit); dirty = true; }
    return cache.results[commit];
  };
  const hiddenKnowledge = new Set<string>();
  for (const v of heads(store).values()) {
    const origin = knowledgeOrigin(store, v);
    if (!origin?.branch || origin.branch === branch) continue;
    if ((anchors.get(v.knowledge_id) ?? []).some(reachable)) continue;
    hiddenKnowledge.add(v.knowledge_id);
  }
  for (const x of store.versions) if (hiddenKnowledge.has(x.knowledge_id)) hidden.add(x.id);
  if (dirty) saveCache(root, cache);
  return hidden;
}
