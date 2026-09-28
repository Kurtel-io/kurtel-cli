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
activateRepo(root);
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
client = await connect(root, ['--allow-remember']);
try {
  const args = { idempotency_key: 'one', quote: 'Never change the billing interface.', source_text: 'User reportedly said: Never change the billing interface.', source_reference: 'conversation:unverified-report', kind: 'constraint', zones: ['src'] };
  const first = JSON.parse(text(await client.callTool({ name: 'remember', arguments: args })));
  assert.equal(first.state, 'proposed'); assert.equal(first.authority, 'unverified_mcp_caller');
  const revision = readKnowledge(root).revision;
  assert(!((await client.callTool({ name: 'remember', arguments: args })).isError));
  assert.equal(readKnowledge(root).revision, revision);
  assert.equal((await client.callTool({ name: 'remember', arguments: { ...args, source_reference: 'other' } })).isError, true);
  assert.equal((await client.callTool({ name: 'remember', arguments: { ...args, idempotency_key: 'two', quote: 'Invented statement' } })).isError, true);
  assert.equal(readKnowledge(root).events.at(-1).kind, 'proposal');
} finally { await client.close(); }
// Corrupt engine settings cannot affect graph-only mode.
writeFileSync(join(dirname(knowledgePath(root)), 'learning.json'), '{not-json');
client = await connect(root, ['--graph-only']);
try {
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['get_context', 'get_impact', 'get_status']);
  assert.match(text(await client.callTool({ name: 'get_context', arguments: { prompt: 'inspect src/billing.ts', phase: 'before_edit' } })), /src\/billing.ts/);
} finally { await client.close(); }
console.log('PASS: real MCP stdio lifecycle, strict inputs, fixed root, activation, kill switch, graph-only isolation, bounded context, sourced history without transcripts and idempotent proposed writes.');
