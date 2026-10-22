// Linked rules: a rule just learned may amend or complete a rule already remembered. The engine says which of the
// closest ones must be read with it; the link is recorded, and the selection delivers the two together.
// In a space (a team's memory) the engine also says which rule the new one replaces, and which it suspends for a
// while: the replaced rule is superseded (kept in the history, no longer delivered, can be made active again), and a
// temporary exception is delivered with the rule it suspends.
import { policyFetch } from "../security/network.js";
import type { KnowledgeStore, KnowledgeVersion } from "../domain/knowledge.js";
import { activeRules, appendKnowledge, digest, emptyBatch } from "../storage/knowledge.js";
import { memoryEnabled, memorySpace } from "../storage/state.js";
import { SENTENCE_MODEL } from "../context/local-models.js";
import { closestRules, refreshSentenceVectors } from "../context/selection.js";
import { engineTarget, noticeMemoryRefusal, sameEngine } from "./engine.js";
import { validityDays } from "./validity.js";

// New rules examined in one run, the existing rules shown for each, and the text sent of each rule.
const NEW_RULES = 12, CANDIDATES = 8, TEXT_LIMIT = 1200;
const LINK_TIMEOUT_MS = 30_000;

type Found = { kind: "read_with" | "supersedes" | "exception_to"; from: string; to: string };

/**
 * Records the links of the rules learned since `since` (ISO date). Runs in background processes, after learning.
 * A rule the engine could not examine keeps no link: the selection then falls back on the closest rule.
 */
export async function linkNewRules(root: string, since: string): Promise<number> {
  const target = engineTarget(root, "link");
  if (!target || !memoryEnabled(root)) return 0;
  const space = memorySpace();
  // With the local models, closeness also counts meaning.
  try { await refreshSentenceVectors(root); } catch { /* Words alone. */ }
  const rules = activeRules(root, SENTENCE_MODEL.id);
  const fresh = rules.map((r, i) => ({ r, i })).filter(x => x.r.recorded_at >= since).slice(0, NEW_RULES);
  if (!fresh.length || rules.length < 2) return 0;
  const closest = closestRules(rules.map(r => ({ content: r.content, vector: r.vector, depth: 0 })));
  const found: Found[] = [];
  const shown = (r: typeof rules[number]) => ({ id: r.version_id, text: r.content.slice(0, TEXT_LIMIT), ...(space ? validityDays(r) : {}) });
  for (const { r, i } of fresh) {
    const candidates = closest(i).slice(0, CANDIDATES).map(j => shown(rules[j]));
    const body = JSON.stringify({ protocol: 1, rule: shown(r), candidates, ...(space ? { space: true } : {}), ...target.where });
    const response = await policyFetch(target.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(LINK_TIMEOUT_MS), headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` }, body }, target.purpose);
    if (!response.ok) { await noticeMemoryRefusal(root, target, response); break; }
    const result = await response.json() as { protocol?: number; linked?: unknown; replaced?: unknown; exceptions?: unknown };
    const ids = new Set(candidates.map(c => c.id));
    const valid = (list: unknown): list is string[] => Array.isArray(list) && list.every(id => typeof id === "string" && ids.has(id));
    if (result.protocol !== 1 || !valid(result.linked) || (space && (!valid(result.replaced) || !valid(result.exceptions)))) break;
    for (const id of new Set(result.linked)) found.push({ kind: "read_with", from: r.version_id, to: id });
    if (space) {
      for (const id of new Set(result.replaced as string[])) found.push({ kind: "supersedes", from: r.version_id, to: id });
      for (const id of new Set(result.exceptions as string[])) found.push({ kind: "exception_to", from: r.version_id, to: id });
    }
  }
  if (!found.length || !memoryEnabled(root) || !sameEngine(root, "link", target)) return 0;
  let recorded = 0;
  appendKnowledge(root, current => {
    const batch = emptyBatch(), now = new Date().toISOString();
    const newest = (knowledgeId: string) => current.versions.filter(v => v.knowledge_id === knowledgeId).reduce<KnowledgeVersion | null>((a, v) => !a || v.version > a.version ? v : a, null);
    for (const { kind, from, to } of found) {
      const a = current.versions.find(v => v.id === from), b = current.versions.find(v => v.id === to);
      if (!a || !b) continue;
      batch.relations.push({ id: `link:${digest(`${kind === "read_with" ? "" : `${kind}:`}${from}:${to}`)}`, kind, from: { type: "version", id: from }, to: { type: "version", id: to }, source_ids: a.source_ids, recorded_at: now, valid_from: null, valid_until: null });
      // Replaced: superseded, unless it changed since it was shown to the engine.
      if (kind === "supersedes" && newest(b.knowledge_id)?.id === b.id && b.state === "active" && !batch.versions.some(v => v.knowledge_id === b.knowledge_id)) {
        batch.versions.push({ ...b, id: `version:${digest(`${b.id}:superseded:${from}`)}`, version: b.version + 1, previous_version_id: b.id, state: "superseded", recorded_at: now });
      }
    }
    recorded = batch.relations.length;
    return batch;
  }, undefined, { versionIds: found.flatMap(f => [f.from, f.to]) });
  return recorded;
}

/**
 * Rules a newer one replaced (a `supersedes` link), newest first: what `reactivate` can bring back. A duplicate the
 * shared memory merged into another is superseded too, but stays merged.
 */
export function replacedRules(store: { versions: KnowledgeVersion[]; relations: KnowledgeStore["relations"] }): KnowledgeVersion[] {
  const heads = new Map<string, KnowledgeVersion>(), versions = new Map(store.versions.map(v => [v.id, v]));
  for (const v of store.versions) if ((heads.get(v.knowledge_id)?.version ?? 0) < v.version) heads.set(v.knowledge_id, v);
  const replaced = new Set(store.relations.filter(r => r.kind === "supersedes").map(r => versions.get(r.to.id)?.knowledge_id));
  return [...heads.values()].filter(v => v.state === "superseded" && replaced.has(v.knowledge_id)).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

/** A replacement was wrong: the replaced rule is active again (a new version; the history keeps both). */
export function reactivateRule(root: string, id: string): KnowledgeVersion {
  let revived: KnowledgeVersion | null = null;
  appendKnowledge(root, current => {
    const matches = replacedRules(current).filter(v => v.knowledge_id === id || v.id === id || v.knowledge_id.startsWith(id) || v.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? "Several replaced rules match: give more of the id" : "No replaced rule with this id");
    const head = matches[0], now = new Date().toISOString();
    const batch = emptyBatch();
    revived = { ...head, id: `version:${digest(`${head.id}:reactivated:${now}`)}`, version: head.version + 1, previous_version_id: head.id, state: "active", recorded_at: now };
    batch.versions.push(revived);
    return batch;
  });
  return revived!;
}
