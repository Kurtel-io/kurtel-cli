// Memory mechanics in throwaway repositories: activation by project markers, not by kurtel.io access.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(join(tmpdir(), 'kurtel-maintenance-'));
const root = join(temp, 'repo'), home = join(temp, 'home'); mkdirSync(root); mkdirSync(home); mkdirSync(join(root, 'src'));
process.env.HOME = home; process.env.USERPROFILE = home;
const { activateRepo } = await import('../dist/storage/state.js');
const { setCaptureEnabled, captureHook, ingestSession } = await import('../dist/integrations/session-capture.js');
const { recordInjection, priorInjectionHints, recordToolUse, usageReport } = await import('../dist/storage/usage.js');
const { appendKnowledge, emptyBatch, readKnowledge } = await import('../dist/storage/knowledge.js');
const { maintenanceFacts, usageEvidence } = await import('../dist/memory/maintenance.js');
const { codeObservations, compareCode } = await import('../dist/storage/code-observations.js');
const { saveIndex } = await import('../dist/storage/graph-index.js');
const { currentBranch } = await import('../dist/repository/git.js');
const { configureLearning } = await import('../dist/memory/session-learning.js');
const { compactContext } = await import('../dist/context/compact.js');
const { evaluationRequest } = await import('../dist/memory/darwinian.js');
const { captureCodex } = await import('../dist/integrations/codex/capture.js');
activateRepo(root); setCaptureEnabled(root, true);
const now = new Date().toISOString();
const version = { id: 'version:memory', knowledge_id: 'memory', version: 1, previous_version_id: null, kind: 'constraint', state: 'active', content: 'Use gatewayAdapter.', zones: ['src/a.ts'], source_ids: ['proof'], event_ids: [], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null };
appendKnowledge(root, () => ({ ...emptyBatch(), sources: [{ id: 'proof', kind: 'document', reference: 'test-rule', revision: null, content: 'Use gatewayAdapter.', recorded_at: now }], versions: [version] }));
writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;');
utimesSync(join(root, 'src/a.ts'), new Date(0), new Date(0));
const module = { id: 'src/a.ts', exports: ['a'], imports: [], loc: 10, degree: 0, symbols: [{ name: 'a', line: 1, calls: [] }] };
const index = { version: 1, repo: 'fixture', branch: currentBranch(root), modules: [module], files_indexed: 1, routes: [], domains: [], god_nodes: [] };
saveIndex(root, index);
const baseline = codeObservations(root, index, ['src/a.ts']); assert.equal(baseline.length, 1);
assert.equal(compareCode(root, baseline, baseline).state, 'unchanged');
assert.equal(compareCode(root, baseline, []).state, 'unknown');

let tick = 0;
async function send(session, hook, payload) {
  await new Promise(resolve => setTimeout(resolve, 4));
  captureHook(root, hook, { session_id: session, prompt_id: `p${tick}`, tool_use_id: `t${tick++}`, ...payload });
}
async function turn(session, kind) {
  recordInjection(root, session, 'PreToolUse', 40, [{ key: 'memory:action:version:memory:hash', text: version.content, files: ['src/a.ts', 'src/b.ts'] }]);
  await send(session, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: kind === 'ignored' ? 'src/other.ts' : 'src/a.ts' } });
  if (kind === 'success' || kind === 'error') await send(session, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: kind === 'success' ? 0 : 1 } });
  if (kind === 'incomplete') { ingestSession(root, session); return; }
  await send(session, 'stop', { last_assistant_message: 'Done.' });
  ingestSession(root, session);
}
await turn('incomplete', 'incomplete');
assert(!readKnowledge(root).events.some(e => e.session_id === 'incomplete' && e.content.includes('kurtel-usage-v1')));
await turn('success', 'success'); await turn('failure', 'error'); await turn('ignored', 'ignored');
const store = readKnowledge(root);
const observations = store.events.filter(e => e.content.includes('kurtel-usage-v1')).map(e => ({ event: e, data: JSON.parse(e.content) }));
assert.equal(observations.length, 3);
assert.equal(observations.find(e => e.event.session_id === 'success').data.used_files, 1, 'One of two files is used, not two');
assert.equal(observations.find(e => e.event.session_id === 'success').data.outcome, 'success');
assert.equal(observations.find(e => e.event.session_id === 'failure').data.outcome, 'error');
assert.equal(observations.find(e => e.event.session_id === 'ignored').data.used_files, 0);
assert(observations.every(o => o.event.source_ids.every(id => store.sources.some(s => s.id === id))));
const revision = store.revision; ingestSession(root, 'success'); assert.equal(readKnowledge(root).revision, revision);
assert.equal(usageEvidence(root, store, 'another-session', priorInjectionHints(root, 'success')).events.length, 0);
const facts = maintenanceFacts(root, store, version, index, new Date().toISOString());
assert.equal(facts.observations.length, 3); assert.equal(facts.code.state, 'unchanged');
assert(!JSON.stringify(facts).includes('gatewayAdapter'));
recordToolUse(root, 'success', 'Read', 'src/a.ts');
const report = usageReport(root); assert(report.file_used_rate < report.used_rate, 'Report exposes per-file coverage');

setCaptureEnabled(root, true, 'codex');
captureCodex(root, { cwd: root, session_id: 'mcp', tool_use_id: 'context', hook_event_name: 'PostToolUse', tool_name: 'mcp__kurtel__get_context', tool_response: { content: [{ type: 'text', text: '- constraint: Use gatewayAdapter. Memory version:memory.' }] } });
await new Promise(resolve => setTimeout(resolve, 4));
captureCodex(root, { cwd: root, session_id: 'mcp', tool_use_id: 'edit', hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' } });
await new Promise(resolve => setTimeout(resolve, 4));
captureCodex(root, { cwd: root, session_id: 'mcp', hook_event_name: 'Stop', last_assistant_message: 'Done.' });
assert(readKnowledge(root).events.some(e => e.session_id === 'codex:mcp' && e.content.includes('kurtel-usage-v1')), 'Codex MCP deliveries correlate with captured edits');

const changed = { ...index, modules: [{ ...module, exports: ['newName'], symbols: [], loc: 100 }] };
saveIndex(root, changed);
assert(maintenanceFacts(root, store, version, changed, new Date().toISOString()).code.similarity < .5);
utimesSync(join(root, 'src/a.ts'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
assert.equal(maintenanceFacts(root, store, version, changed, new Date().toISOString()).code.state, 'unknown', 'Stale graph must not withdraw knowledge');
unlinkSync(join(root, 'src/a.ts'));
assert.equal(maintenanceFacts(root, store, version, changed, new Date().toISOString()).code.state, 'missing');
assert.equal(evaluationRequest(root, version.id, ['src/a.ts'], 'investigation', now).maintenance.code.state, 'unknown', 'Current deletion is not evidence about a historical query');
assert.equal(readKnowledge(root).versions.length, 1, 'No automatic deletion or state mutation');

if (process.env.KURTEL_TEST_ENGINE) {
  const { createEngineServer } = await import(pathToFileURL(process.env.KURTEL_TEST_ENGINE).href);
  const token = 'maintenance-test-token-at-least-24'; process.env.KURTEL_ENGINE_TOKEN = token;
  const server = createEngineServer({ token, model: () => { throw Error('No model call allowed'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  configureLearning(root, `http://127.0.0.1:${server.address().port}/v1/extract`);
  try {
    const result = await compactContext(root, changed, 'src/a.ts', { paths: ['src/a.ts'], memoryOnly: true });
    assert(!result.text.includes('gatewayAdapter')); assert(result.warnings.some(w => w.includes('code_target_missing')));
    assert.equal(result.stillValid('memory:action:version:memory:hash'), false, 'Colon-containing version IDs must be invalidated');
    const history = await compactContext(root, changed, 'src/a.ts', { paths: ['src/a.ts'], mode: 'investigation', memoryOnly: true });
    assert(history.text.includes('gatewayAdapter'), 'Withdrawn injection remains investigable');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
console.log('PASS: automatic sourced utility, bounded turns, incomplete-capture abstention, idempotence, per-file usage and graph freshness.');
