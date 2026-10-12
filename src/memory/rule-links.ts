// Linked rules: a rule just learned may amend or complete a rule already remembered. The engine says which of the
// closest ones must be read with it; the link is recorded, and the selection delivers the two together.
import { policyFetch } from "../security/network.js";
import { activeRules, appendKnowledge, digest, emptyBatch } from "../storage/knowledge.js";
import { memoryEnabled } from "../storage/state.js";
import { SENTENCE_MODEL } from "../context/local-models.js";
import { closestRules, refreshSentenceVectors } from "../context/selection.js";
import { engineTarget, noticeMemoryRefusal, sameEngine } from "./engine.js";

// New rules examined in one run, the existing rules shown for each, and the text sent of each rule.
const NEW_RULES = 12, CANDIDATES = 8, TEXT_LIMIT = 1200;
const LINK_TIMEOUT_MS = 30_000;

/**
 * Records the links of the rules learned since `since` (ISO date). Runs in background processes, after learning.
 * A rule the engine could not examine keeps no link: the selection then falls back on the closest rule.
 */
export async function linkNewRules(root: string, since: string): Promise<number> {
  const target = engineTarget(root, "link");
  if (!target || !memoryEnabled(root)) return 0;
  // With the local models, closeness also counts meaning.
  try { await refreshSentenceVectors(root); } catch { /* Words alone. */ }
  const rules = activeRules(root, SENTENCE_MODEL.id);
  const fresh = rules.map((r, i) => ({ r, i })).filter(x => x.r.recorded_at >= since).slice(0, NEW_RULES);
  if (!fresh.length || rules.length < 2) return 0;
  const closest = closestRules(rules.map(r => ({ content: r.content, vector: r.vector, depth: 0 })));
  const pairs: [string, string][] = [];
  for (const { r, i } of fresh) {
    const candidates = closest(i).slice(0, CANDIDATES).map(j => ({ id: rules[j].version_id, text: rules[j].content.slice(0, TEXT_LIMIT) }));
    const body = JSON.stringify({ protocol: 1, rule: { id: r.version_id, text: r.content.slice(0, TEXT_LIMIT) }, candidates, ...target.where });
    const response = await policyFetch(target.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(LINK_TIMEOUT_MS), headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` }, body }, target.purpose);
    if (!response.ok) { await noticeMemoryRefusal(root, target, response); break; }
    const result = await response.json() as { protocol?: number; linked?: unknown };
    const ids = new Set(candidates.map(c => c.id));
    if (result.protocol !== 1 || !Array.isArray(result.linked) || !result.linked.every(id => typeof id === "string" && ids.has(id))) break;
    for (const id of new Set(result.linked as string[])) pairs.push([r.version_id, id]);
  }
  if (!pairs.length || !memoryEnabled(root) || !sameEngine(root, "link", target)) return 0;
  let recorded = 0;
  appendKnowledge(root, current => {
    const batch = emptyBatch(), now = new Date().toISOString();
    for (const [from, to] of pairs) {
      const a = current.versions.find(v => v.id === from), b = current.versions.find(v => v.id === to);
      if (!a || !b) continue;
      batch.relations.push({ id: `link:${digest(`${from}:${to}`)}`, kind: "read_with", from: { type: "version", id: from }, to: { type: "version", id: to }, source_ids: a.source_ids, recorded_at: now, valid_from: null, valid_until: null });
    }
    recorded = batch.relations.length;
    return batch;
  }, undefined, { versionIds: pairs.flat() });
  return recorded;
}
