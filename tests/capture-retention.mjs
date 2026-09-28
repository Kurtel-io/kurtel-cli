// Memory mechanics in throwaway repositories: activation by project markers, not by kurtel.io access.
process.env.KURTEL_ACTIVATION ??= "markers";
// Captured text is a temporary buffer: erased once extraction and the verdict on
// its turn no longer need it; facts, knowledge and its quotes stay.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { createEngineServer } = await import(process.env.KURTEL_TEST_ENGINE ? pathToFileURL(process.env.KURTEL_TEST_ENGINE).href : './fixtures/lesson-engine.mjs');

const temp = mkdtempSync(join(tmpdir(), 'kurtel-retention-'));
const root = join(temp, 'repo'), home = join(temp, 'home'); mkdirSync(root); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { captureHook, setCaptureEnabled, sessionPath } = await import('../dist/integrations/session-capture.js');
const { activateRepo } = await import('../dist/storage/state.js');
const { readKnowledge, knowledgePath } = await import('../dist/storage/knowledge.js');
const { learnSession, configureLearning, prepareExtraction } = await import('../dist/memory/session-learning.js');
const { sessionKey } = await import('../dist/storage/usage.js');
const auto = await import('../dist/memory/automatic.js');
const { ERASED, purgeCaptureText, STALE_CAPTURE_MS } = await import('../dist/memory/capture-retention.js');
activateRepo(root); setCaptureEnabled(root, true);

const token = 'capture-retention-test-token-0000000000000';
process.env.KURTEL_ENGINE_TOKEN = token;
let release = () => {}, gate = Promise.resolve();
const extractionModel = async (_i, input) => 'quote' in input ? { keep: true } : ({ working: [], candidates: input.events.filter(e => e.content.startsWith('DECISION:')).map(e => ({ event_id: e.id, quote: e.content, kind: 'decision', zones: [...new Set(e.content.match(/src\/[\w.]+/g) ?? [])], reason_event_id: null, reason_quote: null })) });
const server = createEngineServer({ token, model: extractionModel, correctionModel: async (_i, input) => {
  if (!('rules' in input)) return { remember: null };
  await gate; return { correction: false, contradicted: [], explanation: null };
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
configureLearning(root, `http://127.0.0.1:${server.address().port}/v1/extract`);
process.argv[1] = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let tick = 0;
const capture = async (session, hook, input) => { await sleep(5); captureHook(root, hook, { session_id: session, prompt_id: `p-${tick}`, tool_use_id: `t-${tick++}`, ...input }); };
const user = (s, prompt) => capture(s, 'user-prompt-submit', { prompt });
const edit = (s, file) => capture(s, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file } });
const shell = (s, command, stdout) => capture(s, 'post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, exit_code: 0 } });
const stop = (s, text) => capture(s, 'stop', { last_assistant_message: text });
const captures = s => readKnowledge(root).events.filter(e => e.session_id === s && e.id.startsWith('capture-event:'));
const sourceOf = e => JSON.parse(readKnowledge(root).sources.find(x => x.id === e.source_ids[0]).content);
const erased = e => sourceOf(e).text_erased === true;
const journal = s => existsSync(sessionPath(root, s)) ? readdirSync(sessionPath(root, s)).filter(n => n.endsWith('.json')) : [];
const pendingFile = s => join(dirname(knowledgePath(root)), 'context', `pending-${sessionKey(s)}.json`);
async function settled(s) { for (let i = 0; i < 400 && existsSync(pendingFile(s)); i++) await sleep(25); assert(!existsSync(pendingFile(s))); }
async function learnAll(s) { while ((await learnSession(root, s)).processed) { /* one batch per call */ } }

// 1. What the next extraction still shows as context is kept; older extracted text is erased.
await user('a', 'Refactor the billing module, secret plan: move rounding to src/pay.ts');
for (let i = 0; i < 8; i++) await shell('a', `npm test -- part ${i}`, `output with private data ${i}`);
await edit('a', 'src/pay.ts');
await stop('a', 'DECISION: src/pay.ts rounds each line to whole cents.');
await learnAll('a');
const a = captures('a');
const kept = a.filter(e => !erased(e)), gone = a.filter(erased);
assert(gone.length >= 4 && kept.length <= 6, `older text erased (${gone.length} erased, ${kept.length} kept)`);
assert(gone.some(e => e.content === ERASED), 'the user message text is gone');
const tool = gone.find(e => sourceOf(e).role === 'tool');
assert.deepEqual(Object.keys(JSON.parse(tool.content)).sort(), ['command', 'erased', 'tool'], 'tool facts stay, output goes');
assert(!JSON.stringify(readKnowledge(root)).includes('output with private data 0'), 'no erased output anywhere in the store');
assert(!sourceOf(gone[0]).text && sourceOf(gone[0]).branch !== undefined && sourceOf(gone[0]).hook, 'facts stay in the source');
assert.equal(journal('a').length, kept.length, 'journal files of erased text are deleted');
// Knowledge keeps its own quote.
assert(readKnowledge(root).versions.some(v => v.content === 'DECISION: src/pay.ts rounds each line to whole cents.'));
// Turns are still reconstructed from facts alone.
assert.deepEqual(auto.sessionTurns(readKnowledge(root), 'a')[0].edits, ['src/pay.ts']);

// 2. Session over, everything extracted and judged: all its text goes.
await capture('a', 'session-end', { reason: 'exit' });
auto.settleSessionEnd(root, 'a');
await learnAll('a');
purgeCaptureText(root, 'a');
assert(captures('a').every(erased), 'nothing left after the session');
assert.equal(journal('a').length, 0);
assert.equal(prepareExtraction(readKnowledge(root), 'a'), null, 'nothing to extract from erased text');

// 3. A user message stays until the turn it judges is settled, even when extracted and out of the context window.
gate = new Promise(resolve => { release = resolve; });
await user('b', 'Add refunds to src/pay.ts');
await edit('b', 'src/pay.ts');
await stop('b', 'Done.');
await user('b', 'Looks right, also add logging please.');
auto.startCorrectionCheck(root, 'b');
for (let i = 0; i < 8; i++) await shell('b', `npm run lint -- ${i}`, `lint ${i}`);
await stop('b', 'Logged.');
await learnAll('b');
const verdictMessage = captures('b').find(e => sourceOf(e).role === 'user' && !sourceOf(e).text_erased && e.content.startsWith('Looks right'));
assert(verdictMessage, 'kept while its verdict is pending');
release(); await settled('b');
assert(erased(captures('b').find(e => e.id === verdictMessage.id)), 'erased once the judged turn is settled');

// 4. A stale session loses all its text, extracted or not (learning may never run).
configureLearning(root);
await user('c', 'Never extracted: confidential roadmap');
await stop('c', 'ok');
assert.equal(purgeCaptureText(root, 'c'), 0, 'fresh and unextracted: kept');
assert(purgeCaptureText(root, undefined, Date.now() + STALE_CAPTURE_MS + 60000) >= 2, 'stale: erased');
assert(captures('c').every(erased));
assert(!JSON.stringify(readKnowledge(root)).includes('confidential roadmap'));

await new Promise(resolve => server.close(resolve));
console.log(`PASS: capture retention (${process.env.KURTEL_TEST_ENGINE ? 'private engine' : 'protocol fixture'}) — context window kept, older text erased with journal files, tool facts kept, knowledge quotes kept, full erasure at session end, verdict message kept until settled, stale sessions erased.`);
