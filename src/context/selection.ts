// Which rules go with a message. Words (BM25) and sentence vectors pick a pool; the engine's reading service scores
// it and its line says which rules the message needs, whatever their number; a rule brings the rules linked to it
// (recorded when it was learned, or else the closest one). Without the service, the local reading model orders the pool and a fixed number is delivered.
import { activeRules, linkedRules, saveSentenceVectors } from "../storage/knowledge.js";
import { policyFetch } from "../security/network.js";
import { engineTarget, noticeMemoryRefusal, type EngineTarget } from "../memory/engine.js";
import { SENTENCE_MODEL, localModelsInstalled, readingScores, sentenceVectors } from "./local-models.js";

// The reading model scores the best of the two first lists, half from each.
const POOL = 40;
// The first rules kept bring the rule closest to them; a linked rule is one of the three closest.
const LINKED_FROM = 2, LINK_REACH = 3;
// Recorded links one of the first rules may bring. Every kept rule bringing its links delivered half off-topic
// rules on the retrieval set.
const TIED_PER_RULE = 2;
// From this pool size, more than this share of it above the line means the line separates nothing; this many are kept.
const CROWD_FROM = 16, CROWD_SHARE = 0.75, CROWD_KEPT = 4;
const SERVICE_MS = 3000, MESSAGE_LIMIT = 24000, RULE_LIMIT = 8000;
// Rules without a vector that one message may compute on the way; the rest wait for the background.
const VECTORS_PER_MESSAGE = 48;
const TIME_LIMIT_MS = Number(process.env.KURTEL_SELECTION_MS ?? 4000);

export interface Rule { content: string; vector: Float32Array | null; depth: number }

/** Words of a text; an identifier also counts through its parts (rule_order: rule, order). */
function words(text: string): string[] {
  const out: string[] = [];
  for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (token.length < 2) continue;
    out.push(token);
    if (token.includes("_")) for (const part of token.split("_")) if (part.length >= 2) out.push(part);
  }
  return out;
}

/** BM25 score of every document for each query, with rarity measured once over the documents. */
function wordScorer(documents: string[], k1 = 1.2, b = 0.75): (query: string) => number[] {
  const docs = documents.map(text => { const counts = new Map<string, number>(), all = words(text); for (const w of all) counts.set(w, (counts.get(w) ?? 0) + 1); return { counts, length: all.length }; });
  const average = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const holding = new Map<string, number>();
  for (const d of docs) for (const w of d.counts.keys()) holding.set(w, (holding.get(w) ?? 0) + 1);
  return query => {
    const wanted = [...new Set(words(query))].filter(w => holding.has(w));
    return docs.map(d => {
      let score = 0;
      for (const w of wanted) {
        const tf = d.counts.get(w);
        if (!tf) continue;
        const n = holding.get(w)!;
        score += Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * d.length / average));
      }
      return score;
    });
  };
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
/** Indexes by score, best first; `only` leaves the others out. */
const order = (scores: number[], only?: (i: number) => boolean) => scores.map((s, i) => [s, i]).filter(x => !only || only(x[1])).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(x => x[1]);
/** Reciprocal rank fusion: a rule well placed by any list comes first; no score has to be comparable. */
function fuse(...orders: number[][]): number[] {
  const s = new Map<number, number>();
  for (const o of orders) o.forEach((i, rank) => s.set(i, (s.get(i) ?? 0) + 1 / (60 + rank)));
  return [...s.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(x => x[0]);
}

/** For a rule, the other rules, closest first, by words and by meaning (by words alone when it has no vector). */
export function closestRules(rules: Rule[], score = wordScorer(rules.map(r => r.content))): (i: number) => number[] {
  const has = (i: number) => rules[i].vector !== null;
  return i => {
    const near = score(rules[i].content), vector = rules[i].vector;
    return (vector ? fuse(order(near), order(rules.map(r => r.vector ? dot(vector, r.vector) : 0), has)) : order(near)).filter(j => j !== i);
  };
}

/** The two first lists, their pool, and the rules close to a rule. Without a message vector, words alone. */
function firstLists(message: string, rules: Rule[], messageVector: Float32Array | null) {
  const texts = rules.map(r => r.content), score = wordScorer(texts), has = (i: number) => rules[i].vector !== null;
  const byWords = order(score(message));
  const byMeaning = messageVector ? order(rules.map(r => r.vector ? dot(messageVector, r.vector) : 0), has) : [];
  // A rule whose vector is not computed yet keeps, in this list, the place its words give it.
  if (messageVector) for (const [rank, i] of byWords.entries()) if (!has(i)) byMeaning.splice(Math.min(rank, byMeaning.length), 0, i);
  const pool = messageVector ? [...new Set([...byWords.slice(0, POOL / 2), ...byMeaning.slice(0, POOL / 2)])] : byWords.slice(0, POOL);
  return { texts, byWords, byMeaning, pool, closest: closestRules(rules, score) };
}

export interface Reading { scores: number[]; line: number; low: number }
/** Rules recorded as linked to a rule (`linkedRules`); none by default. */
export type Tied = (i: number) => number[];

/**
 * Rules the message needs, best first, whatever their number: those the reading service scores at or above its
 * line, and the best two from its lower line. A rule that amends or completes another one is tied to that rule, not
 * to the message: each of the first two brings the rules recorded as linked to it or, when none is recorded, the
 * rule closest to it.
 */
export async function selectRules(message: string, rules: Rule[], messageVector: Float32Array | null, read: (texts: string[]) => Promise<Reading>, tied: Tied = () => []): Promise<number[]> {
  if (!rules.length) return [];
  const { texts, pool, closest } = firstLists(message, rules, messageVector);
  const { scores, line, low } = await read(pool.map(i => texts[i]));
  const ranked = pool.map((i, k) => [scores[k], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  // A line that nearly the whole pool passes tells nothing apart (many rules alike, all as close to the message):
  // only the best few are kept.
  const above = ranked.filter(([s]) => s >= line).length, apart = pool.length < CROWD_FROM || above <= pool.length * CROWD_SHARE;
  const kept = ranked.filter(([s], k) => apart ? s >= line || (k < LINKED_FROM && s >= low) : k < CROWD_KEPT).map(x => x[1]);
  const first = kept.slice(0, LINKED_FROM), linked: number[] = [];
  const free = (j: number) => !kept.includes(j) && !linked.includes(j);
  for (const i of first) {
    const recorded = tied(i);
    if (recorded.length) linked.push(...recorded.filter(free).slice(0, TIED_PER_RULE));
    else { const j = closest(i).slice(0, LINK_REACH).find(free); if (j !== undefined) linked.push(j); }
  }
  return [...first, ...linked, ...kept.slice(LINKED_FROM)];
}

/** Scores of the engine's reading service for these texts; throws when it has none or does not answer. */
async function serviceReading(root: string, target: EngineTarget, message: string, texts: string[]): Promise<Reading> {
  const body = JSON.stringify({ protocol: 1, message: message.slice(0, MESSAGE_LIMIT), rules: texts.map(t => t.slice(0, RULE_LIMIT)), ...target.where });
  const response = await policyFetch(target.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(SERVICE_MS), headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` }, body }, target.purpose);
  if (!response.ok) { await noticeMemoryRefusal(root, target, response); throw new Error(`rank_http_${response.status}`); }
  const result = await response.json() as { protocol: number; scores: number[]; line: number; low_line: number };
  if (result.protocol !== 1 || !Array.isArray(result.scores) || result.scores.length !== texts.length || ![...result.scores, result.line, result.low_line].every(n => Number.isFinite(n))) throw new Error("invalid_rank_response");
  return { scores: result.scores, line: result.line, low: result.low_line };
}

/** Rule indexes, best first. `read` scores texts against the message. */
export async function rankRules(message: string, rules: Rule[], messageVector: Float32Array, read: (texts: string[]) => Promise<number[]>, tied: Tied = () => []): Promise<number[]> {
  if (!rules.length) return [];
  const { texts, byWords, byMeaning, pool, closest } = firstLists(message, rules, messageVector);
  const scores = await read(pool.map(i => texts[i]));
  const both = fuse(byWords, byMeaning), read1 = pool.map((i, k) => [scores[k], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(x => x[1]);
  const byReading = [...read1, ...both.filter(i => !pool.includes(i))];
  // A rule on the task's own files is one more list: the narrowest first.
  const scoped = order(rules.map(r => r.depth), i => rules[i].depth > 0);
  const merged = fuse(byWords, byMeaning, byReading, ...(scoped.length ? [scoped] : []));
  // Each of the first two brings the rule recorded as linked to it, or else the rule closest to it.
  const two = merged.slice(0, LINKED_FROM), added: number[] = [];
  for (const i of two) { const j = [...tied(i), ...closest(i)].find(j => !two.includes(j) && !added.includes(j)); if (j !== undefined) added.push(j); }
  return [...two, ...added, ...merged.filter(i => !two.includes(i) && !added.includes(i))];
}

/** Computes the sentence vectors still missing, at most `limit`; returns how many. */
export async function refreshSentenceVectors(root: string, limit = Number.POSITIVE_INFINITY): Promise<number> {
  if (!localModelsInstalled()) return 0;
  const missing = activeRules(root, SENTENCE_MODEL.id).filter(r => !r.vector).slice(0, limit);
  // Saved batch by batch: a process cut short keeps what it did.
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32), vectors = await sentenceVectors(batch.map(r => r.content), "passage");
    saveSentenceVectors(root, SENTENCE_MODEL.id, batch.map((r, j) => ({ knowledge_id: r.knowledge_id, version_id: r.version_id, vector: vectors[j] })));
  }
  return missing.length;
}

/** Version ids for a message, best first. `chosen`: the reading service set them, and all of them are delivered. */
export interface Selection { ids: string[]; chosen: boolean }

/**
 * The active rules for this message. With the engine's reading service: the rules the message needs. Without it,
 * with the local models: the whole memory in order. Null when neither answers in time (the caller then selects on
 * words alone).
 */
export async function rankedMemory(root: string, message: string, depthOf: (zones: string[]) => number, skip: Set<string>): Promise<Selection | null> {
  let target: EngineTarget | null = null;
  try { target = engineTarget(root, "rank"); } catch { /* Unreadable configuration: no service. */ }
  const local = localModelsInstalled();
  if (!target && !local) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), TIME_LIMIT_MS); timer.unref?.(); });
  const work = (async (): Promise<Selection | null> => {
    if (local) await refreshSentenceVectors(root, VECTORS_PER_MESSAGE);
    const rules = activeRules(root, SENTENCE_MODEL.id).filter(r => !skip.has(r.version_id));
    if (!rules.length) return { ids: [], chosen: false };
    const messageVector = local ? (await sentenceVectors([message], "query"))[0] : null;
    const shaped = rules.map(r => ({ content: r.content, vector: r.vector, depth: depthOf(r.zones) }));
    // Links recorded when a rule was learned, between the rules still to deliver.
    const at = new Map(rules.map((r, i) => [r.knowledge_id, i])), links = new Map<number, number[]>();
    for (const [a, b] of linkedRules(root)) {
      const i = at.get(a), j = at.get(b);
      if (i === undefined || j === undefined || i === j) continue;
      links.set(i, [...(links.get(i) ?? []), j]); links.set(j, [...(links.get(j) ?? []), i]);
    }
    const tied: Tied = i => links.get(i) ?? [];
    if (target) {
      const service = target;
      try { return { ids: (await selectRules(message, shaped, messageVector, texts => serviceReading(root, service, message, texts), tied)).map(i => rules[i].version_id), chosen: true }; }
      catch { /* No reading service, or no answer: the local order, or words. */ }
    }
    if (!messageVector) return null;
    return { ids: (await rankRules(message, shaped, messageVector, texts => readingScores(message, texts), tied)).map(i => rules[i].version_id), chosen: false };
  })().catch(() => null);
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}
