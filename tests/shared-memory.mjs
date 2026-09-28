// Shared knowledge between two developers on the same repository.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const { createEngineServer } = await import('./fixtures/lesson-engine.mjs');
const { createSharedServer } = await import('./fixtures/shared-server.mjs');

const temp = mkdtempSync(join(tmpdir(), 'kurtel-shared-'));
const root = join(temp, 'repo'); mkdirSync(root);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: root });
const homes = { alice: join(temp, 'alice'), bob: join(temp, 'bob') };
Object.values(homes).forEach(h => mkdirSync(h));
const use = dev => { process.env.HOME = homes[dev]; process.env.USERPROFILE = homes[dev]; process.env.KURTEL_SHARED_TOKEN = `token-${dev}-000000000000000000000000`; };
use('alice');

const { captureHook, setCaptureEnabled } = await import('../dist/integrations/session-capture.js');
const { activateRepo } = await import('../dist/storage/state.js');
const { readKnowledge, knowledgePath } = await import('../dist/storage/knowledge.js');
const { learnSession, configureLearning } = await import('../dist/memory/session-learning.js');
const { compactContext } = await import('../dist/context/compact.js');
const { recordInjection, sessionKey } = await import('../dist/storage/usage.js');
const auto = await import('../dist/memory/automatic.js');
const shared = await import('../dist/memory/shared.js');

// Engine and shared server.
const token = 'shared-memory-test-token-00000000000000000';
process.env.KURTEL_ENGINE_TOKEN = token;
let classify = async () => ({ correction: false, contradicted: [], explanation: null });
const engine = createEngineServer({ token,
  model: async (_i, input) => 'quote' in input ? { keep: true } : ({ working: [], candidates: input.events.filter(e => e.content.startsWith('DECISION:')).map(e => ({ event_id: e.id, quote: e.content, kind: 'decision', zones: [...new Set(e.content.match(/src\/[\w.]+/g) ?? [])], reason_event_id: null, reason_quote: null })) }),
  correctionModel: async (instructions, input) => 'rules' in input ? classify(instructions, input) : { remember: null } });
await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
const { server, bodies } = await createSharedServer({ tokens: { 'token-alice-000000000000000000000000': 'alice', 'token-bob-000000000000000000000000': 'bob' } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sharedEndpoint = `http://127.0.0.1:${server.address().port}/api/memory/knowledge`;
process.argv[1] = fileURLToPath(new URL('../dist/index.js', import.meta.url));
for (const dev of ['alice', 'bob']) {
  use(dev); activateRepo(root); setCaptureEnabled(root, true);
  configureLearning(root, `http://127.0.0.1:${engine.address().port}/v1/extract`);
  shared.enableSharing(root, sharedEndpoint);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let tick = 0;
const capture = async (s, hook, input) => { await sleep(5); captureHook(root, hook, { session_id: s, prompt_id: `p-${tick}`, tool_use_id: `t-${tick++}`, ...input }); };
const user = (s, prompt) => capture(s, 'user-prompt-submit', { prompt });
const edit = (s, file) => capture(s, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file } });
const stop = (s, text) => capture(s, 'stop', { last_assistant_message: text });
const heads = () => { const m = new Map(); for (const v of readKnowledge(root).versions) if ((m.get(v.knowledge_id)?.version ?? 0) < v.version) m.set(v.knowledge_id, v); return m; };
const pendingFile = s => join(dirname(knowledgePath(root)), 'context', `pending-${sessionKey(s)}.json`);
async function settled(s) { for (let i = 0; i < 400 && existsSync(pendingFile(s)); i++) await sleep(25); assert(!existsSync(pendingFile(s))); await sleep(300); }
const inject = (s, v) => recordInjection(root, s, 'UserPromptSubmit', 10, [{ key: `memory:action:${v.id}:x`, text: v.content, files: v.zones }]);
const RULE = 'DECISION: src/pay.ts keeps amounts in integer cents.';

// 1. Alice learns; the knowledge is sent with its origin.
use('alice');
await user('alice-1', 'Implement rounding in src/pay.ts, private detail: client ACME-42');
await edit('alice-1', 'src/pay.ts');
await stop('alice-1', RULE);
await learnSession(root, 'alice-1');
const aliceRule = [...heads().values()].find(v => v.content === RULE);
// Not sent before its turn is judged.
assert.equal(shared.sharedConfig(root).pushed.includes(aliceRule.id), false, 'held until the verdict');
assert.equal((await shared.syncShared(root)).pushed, 0);
// Her next message is not a correction: it is sent.
await user('alice-1', 'Good, now add the invoice export.');
auto.startCorrectionCheck(root, 'alice-1');
await settled('alice-1');
assert.equal(shared.sharedConfig(root).pushed.includes(aliceRule.id), true, 'sent once judged');

// 1b. A corrected turn's knowledge is never sent.
classify = async () => ({ correction: true, contradicted: [], explanation: null });
await user('alice-2', 'Export invoices from src/export.ts');
await edit('alice-2', 'src/export.ts');
await stop('alice-2', 'DECISION: src/export.ts writes invoices as XML files.');
await learnSession(root, 'alice-2');
await user('alice-2', 'No, not like that.');
auto.startCorrectionCheck(root, 'alice-2');
await settled('alice-2');
assert.equal([...heads().values()].find(v => v.content.includes('as XML files')).state, 'contested');
await shared.syncShared(root);
assert.equal(bodies.join('\n').includes('as XML files'), false, 'corrected before anyone saw it: never sent');
classify = async () => ({ correction: false, contradicted: [], explanation: null });

// 1c. Session end validates nothing: kept local until confirmed.
const LOCAL = 'DECISION: src/refund.ts refunds go back to the original payment method.';
await user('alice-3', 'Implement refunds in src/refund.ts');
await edit('alice-3', 'src/refund.ts');
await stop('alice-3', LOCAL);
await learnSession(root, 'alice-3');
auto.settleSessionEnd(root, 'alice-3');
await shared.syncShared(root);
const local = [...heads().values()].find(v => v.content === LOCAL);
assert.equal(local.state, 'active', 'still used locally');
assert.equal(bodies.join('\n').includes('original payment method'), false, 'session end: not sent');
await user('alice-4', 'Add partial refunds to src/refund.ts');
inject('alice-4', local);
await edit('alice-4', 'src/refund.ts');
await stop('alice-4', 'Done.');
await user('alice-4', 'Great.');
auto.startCorrectionCheck(root, 'alice-4');
await settled('alice-4');
assert.equal(shared.sharedConfig(root).pushed.includes(local.id), true, 'sent once really confirmed');

// 2. Bob learns the same rule: the server merges them into one.
use('bob');
await user('bob-0', 'Add VAT to src/pay.ts');
await edit('bob-0', 'src/pay.ts');
await stop('bob-0', 'DECISION: src/pay.ts keeps amounts in integer cents');
await learnSession(root, 'bob-0');
await user('bob-0', 'Perfect, thanks.');
auto.startCorrectionCheck(root, 'bob-0');
await settled('bob-0');
await shared.syncShared(root);
const same = [...heads().values()].filter(v => v.content.startsWith('DECISION: src/pay.ts keeps amounts'));
assert.deepEqual(same.map(v => v.state).sort(), ['active', 'superseded'], 'merged, not duplicated');
const bobRule = heads().get(aliceRule.knowledge_id);
assert(bobRule && bobRule.state === 'active' && bobRule.content === RULE);
use('alice');
await shared.syncShared(root);
assert.equal([...heads().values()].filter(v => v.content.startsWith('DECISION: src/pay.ts keeps amounts') && v.state === 'active').length, 1, 'Alice sees one knowledge too');
use('bob');
const context = await compactContext(root, null, 'rounding src/pay.ts', { paths: ['src/pay.ts'], session: 'bob-1' });
assert(context.items.some(i => i.text.includes('integer cents') && i.text.includes('shared by a teammate')), 'teammate provenance');

// 3. Bob's confirmation counts for Alice too.
await user('bob-1', 'Add refunds to src/pay.ts');
inject('bob-1', bobRule);
await edit('bob-1', 'src/pay.ts');
await stop('bob-1', 'Done.');
await user('bob-1', 'Thanks, now the tests please.');
auto.startCorrectionCheck(root, 'bob-1');
await settled('bob-1');
use('alice');
await shared.syncShared(root);
const confirmations = readKnowledge(root).events.filter(e => { try { const d = JSON.parse(e.content); return d.protocol === 'kurtel-confirmation-v1' && d.knowledge_id === aliceRule.knowledge_id; } catch { return false; } });
assert.deepEqual(confirmations.map(e => JSON.parse(e.content).session), ['bob-1'], "Bob's confirmation reached Alice");

// 4. Bob's correction contests it for everyone.
use('bob');
classify = async (_i, input) => ({ correction: true, contradicted: input.rules.filter(r => r.text.includes('integer cents')).map(r => r.id), explanation: null });
await user('bob-2', 'Change totals in src/pay.ts');
inject('bob-2', heads().get(aliceRule.knowledge_id));
await edit('bob-2', 'src/pay.ts');
await stop('bob-2', 'Done.');
await user('bob-2', 'No, since the ledger migration amounts are decimal strings.');
auto.startCorrectionCheck(root, 'bob-2');
await settled('bob-2');
assert.equal(heads().get(aliceRule.knowledge_id).state, 'contested');
use('alice');
await shared.syncShared(root);
assert.equal(heads().get(aliceRule.knowledge_id).state, 'contested', "Bob's correction reached Alice");
const after = await compactContext(root, null, 'rounding src/pay.ts', { paths: ['src/pay.ts'], session: 'alice-2' });
assert(!after.items.some(i => i.text.includes('integer cents')), 'no longer delivered');

// 5. Nothing is sent twice; conversations never leave the machine.
const sent = bodies.length;
assert.deepEqual(await shared.syncShared(root), { pushed: 0, pulled: 0 });
assert.equal(bodies.length, sent + 1, 'one pull, no push');
const wire = bodies.join('\n');
for (const secret of ['ACME-42', 'Implement rounding', 'Thanks, now the tests', 'ledger migration', 'Done.']) assert(!wire.includes(secret), `never sent: ${secret}`);
const learnOp = bodies.map(b => JSON.parse(b)).flatMap(b => b.operations ?? []).find(o => o.type === 'learn');
assert.deepEqual(Object.keys(learnOp.origin).sort(), ['branch', 'commit', 'learned_at', 'session']);
assert.equal(learnOp.origin.branch, 'main');

// 6. Sharing off: nothing leaves.
shared.disableSharing(root);
assert.equal(await shared.syncShared(root), null);

await new Promise(resolve => server.close(resolve));
await new Promise(resolve => engine.close(resolve));
console.log(`PASS: shared knowledge (${process.env.KURTEL_TEST_SHARED ? 'private server' : 'protocol fixture'}) — held until its turn is judged, corrected turn never sent, session end alone keeps it local until confirmed, sent with its origin, same knowledge learned twice merged, received with teammate provenance, confirmations and corrections count for everyone, idempotent sync, no conversation text on the wire, kill switch.`);
