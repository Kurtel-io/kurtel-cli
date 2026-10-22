// Memory mechanics in throwaway repositories: activation by project markers, not by kurtel.io access.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const base = mkdtempSync(join(tmpdir(), 'kurtel-mcp-'));
const root = join(base, 'repo'), inactive = join(base, 'inactive'), home = join(base, 'home');
for (const folder of [root, inactive, home]) mkdirSync(folder);
process.env.HOME = home; process.env.USERPROFILE = home;
const { activateRepo, setKurtelEnabled, setMemoryEnabled } = await import('../dist/storage/state.js');
const { saveIndex } = await import('../dist/storage/graph-index.js');
const { readKnowledge, knowledgePath, appendKnowledge, emptyBatch } = await import('../dist/storage/knowledge.js');
const { countTokens } = await import('../dist/context/budget.js');
const { watcherRunning } = await import('../dist/runtime/reindex.js');
const { execFileSync } = await import('node:child_process');
const { setCaptureEnabled } = await import('../dist/integrations/session-capture.js');
const { configureLearning } = await import('../dist/memory/session-learning.js');
const { createEngineServer } = await import('./fixtures/lesson-engine.mjs');
activateRepo(root);
// Real files matching the fixture index: the watcher started with the server rebuilds the map from them.
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'src', 'billing.ts'), 'export function chargeCustomer() {\n  return 1;\n}\n');
writeFileSync(join(root, 'src', 'checkout.ts'), "import { chargeCustomer } from './billing';\nexport const total = chargeCustomer();\n");
saveIndex(root, { version: 1, repo: 'fixture', branch: 'main', files_indexed: 2, modules: [{ id: 'src/billing.ts', symbols: [{ name: 'chargeCustomer', line: 1, calls: [] }], imports: [], exports: ['chargeCustomer'] }, { id: 'src/checkout.ts', symbols: [], imports: ['src/billing.ts'], exports: [] }], routes: [], god_nodes: [], domains: [] });
const now = new Date().toISOString();
appendKnowledge(root, () => ({ ...emptyBatch(), sources: [{ id: 'proof', kind: 'document', reference: 'decision:billing', revision: '1', recorded_at: now, content: 'PRIVATE TRANSCRIPT' }], versions: [{ id: 'decision-v1', knowledge_id: 'decision', version: 1, previous_version_id: null, kind: 'decision', state: 'active', content: 'Keep billing validation centralized.', zones: ['src'], source_ids: ['proof'], event_ids: [], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null }], relations: [{ id: 'reason', kind: 'motivated_by', from: { type: 'version', id: 'decision-v1' }, to: { type: 'source', id: 'proof' }, source_ids: ['proof'], recorded_at: now, valid_from: null, valid_until: null }] }));
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
async function connect(target, flags = []) {
  const client = new Client({ name: 'kurtel-protocol-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', target, ...flags], cwd: inactive, env: { ...process.env }, stderr: 'pipe' });
  await client.connect(transport); return client;
}
const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
let client = await connect(inactive);
try {
  assert.equal(JSON.parse(text(await client.callTool({ name: 'get_status', arguments: {} }))).active, false);
  assert.equal((await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect src/billing.ts' } })).isError, true);
  assert(!existsSync(join(inactive, '.kurtel')));
} finally { await client.close(); }
client = await connect(root);
// Codex has no session hook: the MCP server itself starts the watcher that keeps the code map current.
for (let i = 0; i < 50 && !watcherRunning(root); i++) await new Promise(r => setTimeout(r, 100));
assert(watcherRunning(root), 'watcher started by the MCP server');
assert(existsSync(join(root, '.kurtel', '.gitignore')) && readFileSync(join(root, '.kurtel', '.gitignore'), 'utf8').includes('index.json'), 'code map kept out of Git');
try {
  assert.equal((await client.listTools()).tools.length, 7);
  assert((await client.listTools()).tools.every(t => t.annotations.readOnlyHint));
  const result = await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect src/billing.ts', budget: 150 } });
  assert(!result.isError); assert.match(text(result), /src\/checkout.ts/); assert(countTokens(text(result)) <= 150);
  const beforeEdit = await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect src/billing.ts', paths: ['src/billing.ts'], phase: 'before_edit' } });
  assert(!beforeEdit.isError); assert(!text(beforeEdit).includes('Keep billing validation centralized.'));
  assert.equal((await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect', phase: 'unknown' } })).isError, true);
  assert.equal((await client.callTool({ name: 'get_team_history', arguments: { id: 'bad' } })).isError, true);
  assert.equal((await client.callTool({ name: 'get_team_history', arguments: { id: 'a'.repeat(64) } })).isError, true); // no team binding
  const impact = JSON.parse(text(await client.callTool({ name: 'get_impact', arguments: { target: 'src/billing.ts' } })));
  assert.equal(impact.direct, 1);
  assert.equal((await client.callTool({ name: 'record_decision', arguments: {} })).isError, true);
  const imported = JSON.parse(text(await client.callTool({ name: 'search_decision_sources', arguments: { query: 'PRIVATE TRANSCRIPT' } })));
  assert.equal(imported.records.length, 0);
  const why = text(await client.callTool({ name: 'explain_decision', arguments: { query: 'decision-v1' } }));
  assert.match(why, /motivated_by/); assert(!why.includes('PRIVATE TRANSCRIPT'));
  const history = JSON.parse(text(await client.callTool({ name: 'search_history', arguments: { query: 'decision', limit: 1 } })));
  assert.equal(history.versions.length, 1); assert.equal(history.sources[0].content, null);
  assert.equal((await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect', root: inactive } })).isError, true);
  assert.equal((await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect', paths: ['../escape'] } })).isError, true);
  assert.equal((await client.callTool({ name: 'remember', arguments: {} })).isError, true);
  // kurtel memory off: graph tools keep working, knowledge tools refuse.
  setMemoryEnabled(root, false);
  assert.equal((await client.callTool({ name: 'get_impact', arguments: { target: 'src/billing.ts' } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'explain_decision', arguments: { query: 'decision-v1' } })).isError, true);
  assert.equal(JSON.parse(text(await client.callTool({ name: 'get_status', arguments: {} }))).graph_only, true);
  setMemoryEnabled(root, true);
  // kurtel off: everything refuses, graph included.
  setKurtelEnabled(root, false);
  assert.equal((await client.callTool({ name: 'get_impact', arguments: { target: 'src/billing.ts' } })).isError, true);
  setKurtelEnabled(root, true);
} finally { await client.close(); }
// A stand-in engine: it keeps the user's message of each turn as a rule, and judges what get_context may deliver.
const engine = createEngineServer({ token: 'test-token', model: async (_instructions, input) => ({ candidates: input.events.filter(e => e.role === 'user').map(e => ({ event_id: e.id, quote: e.content, kind: 'constraint', zones: [], reason_event_id: null, reason_quote: null })), working: [] }) });
await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
configureLearning(root, `http://127.0.0.1:${engine.address().port}/v1/extract`);
process.env.KURTEL_ENGINE_TOKEN = 'test-token';
client = await connect(root, ['--allow-remember']);
try {
  assert.equal((await client.listTools()).tools.length, 10);
  const args = { idempotency_key: 'one', quote: 'Never change the billing interface.', source_text: 'User reportedly said: Never change the billing interface.', source_reference: 'conversation:unverified-report', kind: 'constraint', zones: ['src'] };
  const first = JSON.parse(text(await client.callTool({ name: 'remember', arguments: args })));
  // What the agent chose to keep is active at once.
  assert.equal(first.state, 'active'); assert.equal(first.authority, 'unverified_mcp_caller');
  const revision = readKnowledge(root).revision;
  assert(!((await client.callTool({ name: 'remember', arguments: args })).isError));
  assert.equal(readKnowledge(root).revision, revision);
  assert.equal((await client.callTool({ name: 'remember', arguments: { ...args, source_reference: 'other' } })).isError, true);
  assert.equal((await client.callTool({ name: 'remember', arguments: { ...args, idempotency_key: 'two', quote: 'Invented statement' } })).isError, true);
  assert.equal(readKnowledge(root).events.at(-1).kind, 'proposal');
  // The same words under another key are not stored twice.
  const again = JSON.parse(text(await client.callTool({ name: 'remember', arguments: { ...args, idempotency_key: 'three', source_text: 'Said again: never change the billing interface.', quote: 'never change the billing interface.' } })));
  assert.equal(again.already_known, true); assert.equal(again.version_id, first.version_id);
  assert.equal(readKnowledge(root).revision, revision);
  // And it is delivered with the next task that concerns it.
  assert.match(text(await client.callTool({ name: 'get_context', arguments: { prompt: 'change the billing interface in src/billing.ts', paths: ['src/billing.ts'] } })), /Never change the billing interface\./);

  // A passage handed over by an agent without hooks: refused while capture is off, then captured once, in order, and learned from.
  const rule = 'Always quote invoice amounts in euros, never in dollars.';
  const passage = { session_id: 's1', idempotency_key: 'k1', messages: [{ role: 'user', content: 'Prepare the invoice summary for this customer.' }, { role: 'assistant', content: 'Here it is, with the amounts in dollars.' }, { role: 'user', content: rule }, { role: 'assistant', content: 'Understood, euros from now on.' }], speaker: 'Inès Moreau' };
  assert.equal((await client.callTool({ name: 'learn_from_conversation', arguments: passage })).isError, true);
  assert.equal((await client.callTool({ name: 'learn_from_conversation', arguments: { ...passage, messages: [] } })).isError, true);
  setCaptureEnabled(root, true);
  assert.equal(JSON.parse(text(await client.callTool({ name: 'learn_from_conversation', arguments: passage }))).session_id, 'mcp:s1');
  assert(!((await client.callTool({ name: 'learn_from_conversation', arguments: passage })).isError));
  let learned;
  for (let i = 0; i < 150 && !learned; i++) {
    await new Promise(r => setTimeout(r, 200));
    learned = readKnowledge(root).versions.find(v => v.content === rule);
  }
  assert(learned, 'the passage was learned from in the background'); assert.equal(learned.state, 'active');
  const captured = readKnowledge(root).events.filter(e => e.session_id === 'mcp:s1' && e.id.startsWith('capture-event:')).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  assert.deepEqual(captured.map(e => e.kind), ['instruction', 'proposal', 'instruction', 'proposal'], 'a retried passage is captured once, in order');
  // Delivered with the name of the person who said it.
  assert.match(text(await client.callTool({ name: 'get_context', arguments: { prompt: 'Quote the invoice amounts for this customer' } })), /The user \(Inès Moreau\) said this[^]*Always quote invoice amounts in euros/);
  const named = { idempotency_key: 'named', quote: 'I am the one who approves refunds above 500 euros.', source_text: 'From now on, I am the one who approves refunds above 500 euros.', source_reference: 'conversation://refunds', kind: 'fact', zones: [], speaker: 'Priya Shah' };
  assert(!((await client.callTool({ name: 'remember', arguments: named })).isError));
  assert.match(text(await client.callTool({ name: 'get_context', arguments: { prompt: 'Who approves refunds above 500 euros?' } })), /\(Priya Shah, \d{4}-\d{2}-\d{2}\)[^]*I am the one who approves refunds/);
} finally { await client.close(); engine.close(); }
// Corrupt engine settings cannot affect graph-only mode.
writeFileSync(join(dirname(knowledgePath(root)), 'learning.json'), '{not-json');
client = await connect(root, ['--graph-only']);
try {
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['get_context', 'get_impact', 'get_status']);
  assert.match(text(await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect src/billing.ts', phase: 'before_edit' } })), /src\/billing.ts/);
} finally { await client.close(); }
execFileSync(process.execPath, [cli, 'watch', 'stop'], { cwd: root, env: process.env, stdio: 'ignore' });
console.log('PASS: real MCP stdio lifecycle, watcher started for Codex, code map ignored by Git, strict inputs, fixed root, activation, kill switch, graph-only isolation, bounded context, sourced history without transcripts, idempotent writes active at once and delivered, a handed-over passage captured once in order and learned from.');
