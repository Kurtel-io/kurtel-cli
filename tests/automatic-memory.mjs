// Automatic memory end to end: real captures and the real detached classifier, in a throwaway repository.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { createEngineServer } = await import(process.env.KURTEL_TEST_ENGINE ? pathToFileURL(process.env.KURTEL_TEST_ENGINE).href : './fixtures/lesson-engine.mjs');

const temp = mkdtempSync(join(tmpdir(), 'kurtel-automatic-'));
const root = join(temp, 'repo'), home = join(temp, 'home'); mkdirSync(root); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { captureHook, setCaptureEnabled, ingestSession } = await import('../dist/integrations/session-capture.js');
const { activateRepo } = await import('../dist/storage/state.js');
const { appendKnowledge, emptyBatch, readKnowledge, knowledgePath } = await import('../dist/storage/knowledge.js');
const { learnSession, configureLearning } = await import('../dist/memory/session-learning.js');
const { compactContext } = await import('../dist/context/compact.js');
const { recordInjection, sessionKey } = await import('../dist/storage/usage.js');
const auto = await import('../dist/memory/automatic.js');
activateRepo(root); setCaptureEnabled(root, true);

// Engine with controllable models.
const token = 'automatic-memory-test-token-000000000000';
process.env.KURTEL_ENGINE_TOKEN = token;
const requests = [];
let lastExplanation = null;
let classify = async () => ({ correction: false, contradicted: [], explanation: null });
// The candidate filter keeps everything.
const extractionModel = async (_instructions, input) => 'quote' in input ? { keep: true } : ({ working: [], candidates: input.events.filter(e => e.content.startsWith('DECISION:') || e.content.includes('must stay whole')).map(e => ({ event_id: e.id, quote: e.content, kind: 'decision', zones: [...new Set(e.content.match(/src\/[\w.]+/g) ?? [])], reason_event_id: null, reason_quote: null })) });
const server = createEngineServer({ token, model: extractionModel, correctionModel: async (instructions, input) => {
  // Second question: what to remember.
  if (!('rules' in input)) return { remember: lastExplanation };
  requests.push(input); const out = await classify(instructions, input); lastExplanation = out.explanation ?? null; return out;
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
configureLearning(root, `${origin}/v1/extract`);
// The prompt hook spawns the CLI from argv[1].
process.argv[1] = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let tick = 0;
async function capture(session, hook, input) {
  await sleep(5);
  captureHook(root, hook, { session_id: session, prompt_id: `p-${tick}`, tool_use_id: `t-${tick++}`, ...input });
}
const user = (s, prompt) => capture(s, 'user-prompt-submit', { prompt });
const edit = (s, file) => capture(s, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file } });
const stop = (s, text) => capture(s, 'stop', { last_assistant_message: text });
const heads = () => { const m = new Map(); for (const v of readKnowledge(root).versions) if ((m.get(v.knowledge_id)?.version ?? 0) < v.version) m.set(v.knowledge_id, v); return m; };
const head = knowledgeId => heads().get(knowledgeId);
const pendingFile = session => join(dirname(knowledgePath(root)), 'context', `pending-${sessionKey(session)}.json`);
async function settled(session) { for (let i = 0; i < 400 && existsSync(pendingFile(session)); i++) await sleep(25); assert(!existsSync(pendingFile(session)), 'classifier finished'); }
const events = protocol => readKnowledge(root).events.filter(e => { try { return JSON.parse(e.content).protocol === protocol; } catch { return false; } });

let ruleCount = 0;
function seedRule(text, zones = ['src/pay.ts']) {
  const id = `rule-${++ruleCount}`, source = `rule-source-${ruleCount}`;
  appendKnowledge(root, () => ({ ...emptyBatch(), sources: [{ id: source, kind: 'document', reference: `seed/${id}`, revision: null, content: text, recorded_at: new Date().toISOString() }],
    versions: [{ id: `version:${id}`, knowledge_id: id, version: 1, previous_version_id: null, kind: 'constraint', state: 'active', content: text, zones, source_ids: [source], event_ids: [], recorded_at: new Date().toISOString(), valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null }] }));
  return id;
}
const inject = (session, knowledgeId) => { const v = head(knowledgeId); recordInjection(root, session, 'UserPromptSubmit', 10, [{ key: `memory:action:${v.id}:x`, text: v.content, files: v.zones }]); };

// 1. Knowledge is active by default.
await user('s1', 'Implement rounding in src/pay.ts');
await edit('s1', 'src/pay.ts');
await stop('s1', 'DECISION: src/pay.ts keeps amounts in cents to round per line.');
await learnSession(root, 's1');
const learned = [...heads().values()].find(v => v.content.startsWith('DECISION: src/pay.ts'));
assert.equal(learned.state, 'active', 'no promotion needed');

// 2. A next message confirms what served, once per turn.
const served = seedRule('Round each invoice line separately.'), unused = seedRule('Retry webhooks three times.', ['src/webhooks.ts']);
await user('s2', 'Add a discount to src/pay.ts');
inject('s2', served); inject('s2', served); inject('s2', unused);
await edit('s2', 'src/pay.ts');
await stop('s2', 'Done.');
await user('s2', 'Great, now add a test for it.');
auto.startCorrectionCheck(root, 's2');
await settled('s2');
const confirmations = events('kurtel-confirmation-v1');
assert.equal(confirmations.filter(e => JSON.parse(e.content).knowledge_id === served).length, 1, 'one confirmation per turn');
assert.equal(confirmations.filter(e => JSON.parse(e.content).knowledge_id === unused).length, 0, 'not used: no change');
assert.equal(head(unused).state, 'active');
// Only the user's message and Kurtel's own injected rules reach the engine.
const sent = requests.at(-1);
assert.deepEqual(Object.keys(sent).sort(), ['agent_turn', 'message', 'rules']);
assert.deepEqual(sent.agent_turn, { agent_edited_files: ['src/pay.ts'], agent_ran_commands: 0 }, 'facts about the judged turn, not its text');
assert.equal(sent.message, 'Great, now add a test for it.');
assert(sent.rules.every(r => /^version:/.test(r.id)) && sent.rules.some(r => r.text === 'Round each invoice line separately.'));
assert(!JSON.stringify(sent).includes('Done.'), 'agent messages are never sent');

// 3. A correction contests what it contradicts; the user's explanation becomes knowledge.
const contradicted = seedRule('Amounts are stored in euros.');
await user('s3', 'Store the refund amount in src/pay.ts');
inject('s3', contradicted);
await edit('s3', 'src/pay.ts');
await stop('s3', 'DECISION: src/pay.ts stores refunds as euro floats.');
await learnSession(root, 's3');
const agentKnowledge = [...heads().values()].find(v => v.content.includes('euro floats'));
assert.equal(agentKnowledge.state, 'active');
let release; const gate = new Promise(resolve => { release = resolve; });
classify = async (_i, input) => { await gate; return { correction: true, contradicted: input.rules.filter(r => r.text === 'Amounts are stored in euros.').map(r => r.id), explanation: 'amounts must stay in cents because accounting rounds line by line' }; };
await user('s3', 'No, amounts must stay in cents because accounting rounds line by line.');
auto.startCorrectionCheck(root, 's3');
const during = await compactContext(root, null, 'refund amount src/pay.ts', { paths: ['src/pay.ts'], session: 's3' });
assert(!during.items.some(i => i.text.includes('euro floats')), 'suspended while being judged');
release(); await settled('s3');
assert.equal(head(contradicted).state, 'contested', 'contradicted injected rule');
assert.equal(head(agentKnowledge.knowledge_id).state, 'contested', 'what the corrected turn produced');
assert.equal(head(served).state, 'active', 'unrelated knowledge untouched');
const explained = [...heads().values()].find(v => v.content === 'amounts must stay in cents because accounting rounds line by line');
assert(explained && explained.state === 'active' && explained.kind === 'constraint' && explained.zones.includes('src/pay.ts'));
assert(explained.event_ids.some(id => id.startsWith('correction:')));
const correctionEvent = events('kurtel-correction-v1').at(-1);
assert(!correctionEvent.content.includes('accounting'), 'no message text in the correction event');
const after = await compactContext(root, null, 'refund amount src/pay.ts', { paths: ['src/pay.ts'], session: 's3' });
assert(after.items.some(i => i.text.includes('stated by the user when correcting the agent')));
assert(!after.items.some(i => i.text.includes('euro floats') || i.text.includes('stored in euros')));

// 4. Extraction that finishes after the verdict follows it (born contested).
await user('s4', 'Update src/pay.ts totals');
await edit('s4', 'src/pay.ts');
await stop('s4', 'DECISION: src/pay.ts totals truncate cents.');
classify = async () => ({ correction: true, contradicted: [], explanation: null });
await user('s4', 'No.');
auto.startCorrectionCheck(root, 's4');
await settled('s4');
const before = readKnowledge(root).versions.length;
await learnSession(root, 's4');
const late = [...heads().values()].find(v => v.content.includes('truncate cents'));
assert.equal(late.state, 'contested', 'born contested');
// A bare "No." creates no knowledge of its own.
assert(!readKnowledge(root).versions.slice(before).some(v => v.content === 'No.'));
assert(![...heads().values()].some(v => v.event_ids.some(id => id.startsWith('correction:')) && v.content === 'No.'));

// 5. Classifier unavailable: nothing is stored; what the turn produced is not restored.
await user('s5', 'Change src/pay.ts rounding');
await edit('s5', 'src/pay.ts');
await stop('s5', 'DECISION: src/pay.ts rounds half up.');
await learnSession(root, 's5');
const risky = [...heads().values()].find(v => v.content.includes('half up'));
const confirmationsBefore = events('kurtel-confirmation-v1').length;
classify = async () => { throw new Error('classifier down'); };
await user('s5', 'Hmm, keep going with the next step.');
auto.startCorrectionCheck(root, 's5');
await settled('s5');
assert.equal(head(risky.knowledge_id).state, 'archived', 'withheld, not restored');
assert.equal(events('kurtel-confirmation-v1').length, confirmationsBefore, 'no confirmation without a verdict');
assert(events('kurtel-withheld-v1').length >= 1);
// Later extraction from a withheld turn stores nothing.
await user('s6', 'Refactor src/pay.ts');
await edit('s6', 'src/pay.ts');
await stop('s6', 'DECISION: src/pay.ts uses banker rounding.');
await user('s6', 'next');
auto.startCorrectionCheck(root, 's6');
await settled('s6');
await learnSession(root, 's6');
assert(![...heads().values()].some(v => v.content.includes('banker rounding')), 'nothing stored from a withheld turn');

// 6. A classifier that died leaves a stale marker: its turn is withheld on the next message.
classify = async () => ({ correction: false, contradicted: [], explanation: null });
await user('s7', 'Edit src/pay.ts');
await edit('s7', 'src/pay.ts');
await stop('s7', 'ok');
await user('s7', 'continue');
ingestSession(root, 's7');
const turns7 = auto.sessionTurns(readKnowledge(root), 's7');
mkdirSync(dirname(pendingFile('s7')), { recursive: true });
writeFileSync(pendingFile('s7'), JSON.stringify({ session: 's7', turn: turns7[0].user.id, message: turns7[1].user.id, created_at: new Date(Date.now() - 120000).toISOString() }));
await user('s7', 'and again');
auto.startCorrectionCheck(root, 's7');
await settled('s7');
assert(events('kurtel-withheld-v1').some(e => JSON.parse(e.content).turn === turns7[0].user.id));

// 7. Session end validates nothing.
const lastRule = seedRule('Log every refund.');
await user('s8', 'Add refund logging in src/pay.ts');
inject('s8', lastRule);
await edit('s8', 'src/pay.ts');
await stop('s8', 'Added.');
auto.settleSessionEnd(root, 's8');
const lastTurn = auto.sessionTurns(readKnowledge(root), 's8').at(-1).user.id;
assert.equal(auto.turnVerdict(readKnowledge(root), 's8', lastTurn), 'session_end');
assert.equal(events('kurtel-confirmation-v1').filter(e => JSON.parse(e.content).knowledge_id === lastRule).length, 0, 'no confirmation from a session end');
auto.settleSessionEnd(root, 's8');
assert.equal(events('kurtel-turn-settled-v1').filter(e => JSON.parse(e.content).turn === lastTurn).length, 1, 'idempotent');

// 8. Only hard knowledge holds an edit.
const hardRule = seedRule('Never log card numbers.', ['src/card.ts']), softRule = seedRule('Prefer small functions.', ['src/card.ts']);
for (const [session, turns] of [['h1', 2], ['h2', 1]]) {
  for (let n = 0; n < turns; n++) {
    await user(session, `Work on src/card.ts ${n}`);
    auto.startCorrectionCheck(root, session); await settled(session);
    inject(session, hardRule);
    await edit(session, 'src/card.ts');
    await stop(session, 'ok');
  }
  await user(session, 'Thanks, that is all.');
  auto.startCorrectionCheck(root, session); await settled(session);
  auto.settleSessionEnd(root, session);
}
const preEdit = await compactContext(root, null, 'src/card.ts', { paths: ['src/card.ts'], memoryOnly: true, session: 'h3' });
assert(preEdit.items.some(i => i.text.includes('Never log card numbers.')), 'hard knowledge holds the edit');
assert(!preEdit.items.some(i => i.text.includes('Prefer small functions.')), 'not hard: not before the edit');
const prompt = await compactContext(root, null, 'card logging src/card.ts', { paths: ['src/card.ts'], session: 'h3' });
assert(prompt.items.some(i => i.text.includes('Prefer small functions.')), 'still delivered at the prompt');

// 9. Correction and extraction of the same message: one knowledge, in either order.
const explanation = 'quantities must stay whole because stock counts units';
const copies = () => [...heads().values()].filter(v => v.content.toLowerCase().includes(explanation));
// a. Extraction first.
classify = async () => ({ correction: true, contradicted: [], explanation });
await user('d1', 'Allow fractional quantities in src/stock.ts');
await edit('d1', 'src/stock.ts');
await stop('d1', 'Done.');
await user('d1', `No, ${explanation}.`);
await learnSession(root, 'd1');
assert.equal(copies().length, 1, 'extracted before the verdict');
auto.startCorrectionCheck(root, 'd1');
await settled('d1');
assert.equal(copies().length, 1, 'no second copy from the correction');
const merged = copies()[0];
assert(merged.state === 'active' && merged.content === explanation && merged.event_ids.some(id => id.startsWith('correction:')), 'exact explanation with the correction head start');
// b. Correction first.
await user('d2', 'Allow fractional quantities in src/stock.ts again');
await edit('d2', 'src/stock.ts');
await stop('d2', 'Done.');
await user('d2', `No, ${explanation}!`);
auto.startCorrectionCheck(root, 'd2');
await settled('d2');
await learnSession(root, 'd2');
assert.equal(copies().length, 1, 'extraction after the verdict adds no copy');

await new Promise(resolve => server.close(resolve));
console.log(`PASS: automatic memory (${process.env.KURTEL_TEST_ENGINE ? 'real engine' : 'fixture'}) — active by default, suspension, confirmation by silence, contradiction, user explanation, bare no, born contested, withheld on failure and stale classifier, session end validates nothing, hard-only pre-edit, user message and own rules only, no duplicate between correction and extraction.`);
