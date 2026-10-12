// Order of the rules for a message: three lists merged, the linked rule brought in, and the fallback on words.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.KURTEL_MODELS_DIR = join(mkdtempSync(join(tmpdir(), 'kurtel-selection-')), 'none');
// No engine here: activation by project markers, and no engine token.
process.env.KURTEL_ACTIVATION = 'markers'; delete process.env.KURTEL_ENGINE_TOKEN;
const { rankRules, rankedMemory, refreshSentenceVectors, selectRules } = await import('../dist/context/selection.js');

// Vectors over three meanings: export, logging, epochs.
const v = (...x) => { const n = Math.hypot(...x); return Float32Array.from(x.map(a => a / n)); };
const rules = [
  { content: 'Logs go through the audit logger, never print.', vector: v(0, 1, 0), depth: 0 },
  { content: 'Archive exports are signed with the ledger key under epoch E7.', vector: v(1, 0, .2), depth: 0 },
  { content: 'Supersede epoch E7: use epoch E9 from now on.', vector: v(.1, 0, 1), depth: 0 },
  { content: 'Retry the nightly job with an exponential delay.', vector: v(0, .6, .1), depth: 0 },
  { content: 'Keep the changelog in reverse order.', vector: v(.2, .3, 0), depth: 0 },
  { content: 'Quarterly export files are written as CSV.', vector: v(.9, 0, 0), depth: 0 },
];
const message = 'Add an archive export command for the auditors.';
// A reading model with no opinion: the order comes from words and vectors.
const flat = async texts => texts.map(() => 0);
const order = await rankRules(message, rules, v(1, 0, 0), flat);
assert.equal(order.length, rules.length, 'every rule is placed once');
assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5]);
assert.equal(order[0], 1, 'words and meaning agree on the first rule');
assert(order.slice(0, 4).includes(2), 'the rule that amends the first one comes with it, though it shares nothing with the message');
assert(order.indexOf(2) < order.indexOf(0), 'ahead of an unrelated rule');

// The reading model's order of the pool counts as a third list.
const prefers = index => async texts => texts.map(t => t === rules[index].content ? 5 : -5);
const blind = Float32Array.from([0, 0, 0]);
assert((await rankRules(message, rules, blind, prefers(3))).indexOf(3) < (await rankRules(message, rules, blind, flat)).indexOf(3), 'the rule the reading model prefers moves up');

// A rule on the task's own file is one more list.
const scoped = rules.map((r, i) => ({ ...r, depth: i === 4 ? 6 : 0 }));
assert((await rankRules(message, scoped, v(1, 0, 0), flat)).indexOf(4) < order.indexOf(4), 'a rule of the task file moves up');

// A rule without a vector yet is still placed, by its words.
const partial = rules.map((r, i) => i === 1 ? { ...r, vector: null } : r);
const placed = await rankRules(message, partial, v(1, 0, 0), flat);
assert(placed.indexOf(1) < placed.indexOf(0) && placed.indexOf(1) < placed.indexOf(3), 'no vector: its words still place it ahead of unrelated rules');
assert.deepEqual(await rankRules(message, [], v(1, 0, 0), flat), []);

// The reading service: rules at or above its line, whatever their number; the best two from its lower line; each of
// the first two brings the rule closest to it.
const scored = by => async texts => ({ line: .56, low: .45, scores: texts.map(t => by[rules.findIndex(r => r.content === t)] ?? .1) });
let chosen = await selectRules(message, rules, v(1, 0, 0), scored({ 1: .9 }));
assert.deepEqual(chosen, [1, 2], 'one rule above the line, and the rule that amends it though the service scored it low');
chosen = await selectRules(message, rules, v(1, 0, 0), scored({ 0: .9, 1: .8, 3: .7, 4: .6, 5: .58 }));
assert.deepEqual(chosen.slice(0, 2), [0, 1]); assert.equal(chosen.length, 6, 'five above the line and the one linked rule left');
assert.deepEqual(await selectRules(message, rules, v(1, 0, 0), scored({})), [], 'nothing reaches the lower line: nothing is delivered');
chosen = await selectRules(message, rules, v(1, 0, 0), scored({ 1: .5, 5: .5, 0: .5 }));
assert(chosen.includes(0) && chosen.includes(1) && !chosen.includes(5), 'under the line only the best two are kept');
// A link recorded when a rule was learned replaces the guess by closeness; only the first two rules bring theirs.
const tied = pairs => i => pairs.filter(p => p.includes(i)).map(p => p[0] === i ? p[1] : p[0]);
assert.deepEqual(await selectRules(message, rules, v(1, 0, 0), scored({ 1: .9 }), tied([[1, 4]])), [1, 4], 'the recorded link, not the closest rule');
chosen = await selectRules(message, rules, v(1, 0, 0), scored({ 0: .9, 1: .8, 5: .7 }), tied([[5, 3], [0, 1]]));
assert.deepEqual(chosen, [0, 1, 5], 'a link between two kept rules adds nothing; the third kept rule brings none');
chosen = await selectRules(message, rules, v(1, 0, 0), scored({ 1: .9 }), tied([[1, 0], [1, 3], [1, 4]]));
assert.deepEqual(chosen, [1, 0, 3], 'two recorded links at most for one rule');
assert((await rankRules(message, rules, v(1, 0, 0), flat, tied([[1, 4]]))).indexOf(4) < 4, 'local order: the recorded link comes with the first rules');
// Many rules alike that all pass the line: the line separates nothing, and only the best few are kept.
const alike = Array.from({ length: 20 }, (_, i) => ({ content: `Help line of operator ${i} ends with its band code, written by the archive export generator.`, vector: null, depth: 0 }));
const flatHigh = async texts => ({ line: .56, low: .45, scores: texts.map((_, k) => .77 - k * .001) });
assert.equal((await selectRules(message, alike, null, flatHigh)).filter((i, k, all) => all.indexOf(i) === k).length <= 6, true, 'four kept, and at most one linked rule for each of the first two');
const half = async texts => ({ line: .56, low: .45, scores: texts.map((_, k) => k < 10 ? .8 : .1) });
assert((await selectRules(message, alike, null, half)).length >= 10, 'half of the pool above the line is a choice: all of it is delivered');
// Without sentence vectors the pool and the linked rule come from words.
const bare = rules.map(r => ({ ...r, vector: null }));
assert.deepEqual(await selectRules(message, bare, null, scored({ 1: .9 })), [1, 2], 'the amending rule shares "epoch E7" with the rule it amends');
await assert.rejects(selectRules(message, rules, null, async () => { throw new Error('rank_http_502'); }), /rank_http_502/);
assert.deepEqual(await selectRules(message, [], null, scored({})), []);

// No local models and no engine: the caller selects on words.
assert.equal(await rankedMemory(process.cwd(), message, () => 0, new Set()), null);
assert.equal(await refreshSentenceVectors(process.cwd()), 0);
console.log('PASS: rule order — words, meaning and reading merged, linked rule brought in, task file, missing vector; reading service — line, lower line for the best two, linked rules, no vectors; fallback without models or engine.');
