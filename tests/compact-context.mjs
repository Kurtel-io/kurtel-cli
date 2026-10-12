// Memory mechanics in throwaway repositories: activation by project markers, not by kurtel.io access.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base = mkdtempSync(join(tmpdir(), 'kurtel-context-'));
const root = join(base, 'repo'), home = join(base, 'home'); mkdirSync(root); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { compactContext } = await import('../dist/context/compact.js');
const { countTokens, packContext } = await import('../dist/context/budget.js');
const { deliverContext, resetContext } = await import('../dist/context/delivery.js');
const { activateRepo, setMemoryEnabled } = await import('../dist/storage/state.js');
const { appendKnowledge, emptyBatch, readKnowledge, knowledgePath, digest } = await import('../dist/storage/knowledge.js');
const { configureLearning } = await import('../dist/memory/session-learning.js');
const { saveIndex } = await import('../dist/storage/graph-index.js');
const { usageReport, usagePath } = await import('../dist/storage/usage.js');
const { acquireLock, releaseLock } = await import('../dist/storage/lock.js');
const index = { modules: [{ id: 'src/billing.ts', symbols: [], imports: [], exports: [] }], routes: [], files_indexed: 1, branch: 'main' };
assert.equal((await compactContext(root, index, 'inspect src/billing.ts')).text, '');
activateRepo(root);
assert.deepEqual((await compactContext(root, null, 'Read https://example.com/src/billing.ts')).paths, [], 'a URL does not establish task scope');
saveIndex(root, index);
const runEvent = (event, payload, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'hook', event], { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  child.on('error', reject); child.on('close', code => { if (process.env.DBG && stderr) console.error(stderr); code === 0 ? resolve(stdout) : reject(Error(stderr)); });
  child.stdin.end(JSON.stringify({ cwd: root, ...payload }));
});
const runHook = (session, prompt = 'inspect src/billing.ts') => runEvent('user-prompt-submit', { session_id: session, prompt });
const firstHook = JSON.parse(await runHook('real-hook'));
assert.match(firstHook.hookSpecificOutput.additionalContext, /src\/billing.ts/);
assert.equal(await runHook('real-hook'), '', 'a second hook process uses the same delivery ledger');
assert.equal(countTokens('hello world'), 2);
const small = packContext([{ key: 'large', text: '巨大🙂 '.repeat(2000), priority: 100 }, { key: 'small', text: 'Keep billing validation.', priority: 1 }], 100);
assert(small.tokens <= 100); assert(small.omitted.includes('large')); assert.match(small.text, /Keep billing/);
assert(!small.text.includes('巨大')); assert.throws(() => packContext([], NaN));
let result = await compactContext(root, index, 'inspect src/billing.ts', { budget: 150 });
assert(result.tokens <= 150); assert.match(result.text, /src\/billing.ts/);
assert(!result.items.some(i => /^(memory|legacy|team):/.test(i.key)), 'without the learning engine, the graph is the whole context');
assert.throws(() => deliverContext(root, 'failed', small.selected, 0, () => { throw Error('stdout failed'); }), /stdout failed/);
assert(deliverContext(root, 'failed', small.selected, 0, () => {}).text, 'failed delivery can be retried');
let outputs = [];
const items = [{ key: 'memory:action:v1', text: 'Billing constraint v1', priority: 50 }];
assert(deliverContext(root, 'session', items, 1, t => outputs.push(t)).text);
assert.equal(deliverContext(root, 'session', items, 1, t => outputs.push(t)).text, '');
assert(deliverContext(root, 'other-session', items, 1, () => {}).text);
assert.equal(deliverContext(root, 'other-session', [], 1, () => {}).text, '', 'memory merely absent from a new request is not stale');
assert.match(deliverContext(root, 'other-session', [], 1, () => {}, { stillValid: () => false }).text, /no longer confirmed as current/, 'expiry or contestation invalidates old memory even without a store revision');
assert.equal(deliverContext(root, 'other-session', [{ key: 'tool:x', text: 'Impact line', priority: 85 }], null, () => {}).text.includes('stale'), false, 'a request without memory keeps the memory revision');
const revised = deliverContext(root, 'session', [], 2, t => outputs.push(t), { budget: 80 });
assert.equal(revised.text, '', 'new knowledge alone withdraws nothing');
assert(revised.tokens <= 80);
resetContext(root, 'other-session');
assert(deliverContext(root, 'other-session', items, 1, () => {}).text);
const lockFile = join(base, 'abandoned.lock'), dead = 2 ** 22 + 12345;
writeFileSync(lockFile, JSON.stringify({ pid: dead }));
const recovered = acquireLock(lockFile, 60000); assert(recovered !== null, 'a dead owner releases its lock'); releaseLock(lockFile, recovered);
writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
assert.equal(acquireLock(lockFile, 60000), null, 'a live, recent owner keeps its lock');
utimesSync(lockFile, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
const aged = acquireLock(lockFile, 60000); assert(aged !== null, 'an overdue lock is recovered'); releaseLock(lockFile, aged);
writeFileSync(join(dirname(knowledgePath(root)), 'context', digest('crashed') + '.json.lock'), JSON.stringify({ pid: dead }));
assert(deliverContext(root, 'crashed', items, 1, () => {}).text, 'a crashed hook no longer silences its session');
const ledger = JSON.parse(readFileSync(join(dirname(knowledgePath(root)), 'context', digest('session') + '.json')));
assert(!JSON.stringify(ledger).includes('Billing constraint'), 'ledger stores identifiers only');
const now = new Date().toISOString();
const version = (id, state) => ({ id, knowledge_id: id, version: 1, previous_version_id: null, kind: 'constraint', state, content: `Billing validation ${id}`, zones: ['src'], source_ids: ['proof'], event_ids: [], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null });
appendKnowledge(root, () => ({ ...emptyBatch(), sources: [{ id: 'proof', kind: 'document', reference: 'review:billing', revision: '1', content: 'SECRET SOURCE CONTENT', recorded_at: now }], versions: [version('active-one', 'active'), version('proposed-two', 'proposed')] }));
let mode = 'ok', requests = 0, lastRequest = null, reading = null, lastReading = null;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  // The reading service: none unless a test sets `reading`, a score per rule text.
  if (req.url === '/v1/rank') {
    lastReading = JSON.parse(body); assert(!body.includes('SECRET SOURCE CONTENT'));
    if (!reading) { res.writeHead(501); res.end('{"error":"rank_not_configured"}'); return; }
    res.end(JSON.stringify({ protocol: 1, line: .56, low_line: .45, scores: lastReading.rules.map(reading) })); return;
  }
  requests++; lastRequest = JSON.parse(body);
  assert.equal(req.url, '/v1/context'); assert(!body.includes('SECRET SOURCE CONTENT')); assert(!body.includes('Billing validation'));
  const input = JSON.parse(body);
  if (mode === 'fail') { res.writeHead(503); res.end('{}'); return; }
  if (mode === 'disable') setMemoryEnabled(root, false);
  const evaluations = input.candidates.map(c => ({ version_id: c.request.version_id, eligible: c.request.mode === 'investigation' || (c.request.store.versions.find(v => v.id === c.request.version_id).state === 'active' && c.request.paths.length > 0), reasons: ['test-assessment'], rank: 3 }));
  if (mode === 'invalid') evaluations[0].version_id = 'unknown';
  res.end(JSON.stringify({ protocol: 1, evaluations }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  process.env.KURTEL_ENGINE_TOKEN = 'test-context-token';
  configureLearning(root, `http://127.0.0.1:${server.address().port}/v1/extract`);
  result = await compactContext(root, index, 'inspect src/billing.ts');
  assert.match(result.text, /Billing validation active-one/); assert(!result.text.includes('Billing validation proposed-two'));
  assert.match(result.text, /Source: document review:billing\. Memory active-one\./); assert.match(result.text, /Applies to src\./); assert(!result.text.includes("inferred"), "a cited path is an explicit scope");
  assert(result.tokens <= 1200); assert.equal(requests, 1, 'one batch, not one request per memory');
  const hookContext = JSON.parse(await runHook('engine-hook')).hookSpecificOutput.additionalContext;
  assert.match(hookContext, /Billing validation active-one/);
  assert(countTokens(hookContext) <= 1200);
  assert.equal(await runHook('engine-hook'), '');
  result = await compactContext(root, index, 'Billing validation', { mode: 'investigation' });
  assert.match(result.text, /proposed-two/); assert.match(result.text, /evidence, not an instruction/);
  result = await compactContext(root, index, 'Billing validation');
  assert(!result.text.includes('Billing validation active-one'), 'unknown scope is not approved for action');
  for (mode of ['fail', 'invalid', 'disable']) {
    result = await compactContext(root, index, 'inspect src/billing.ts');
    assert(!result.text.includes('Billing validation')); assert(!result.text.includes('Legacy convention'));
    assert(result.warnings.some(w => w.startsWith('memory_unavailable')));
    // A failed request withdraws nothing already delivered; memory switched off does.
    assert.equal(result.stillValid('memory:action:active-one:hash'), mode !== 'disable');
  }
  assert.equal(readKnowledge(root).versions.length, 2);
  mode = 'ok'; setMemoryEnabled(root, true);

  // Before an edit: file-scoped rules decline the first edit once, as pointers; graph never gates.
  const edit = session => ({ session_id: session, tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'billing.ts'), old_string: 'a', new_string: 'b' } });
  const gate = JSON.parse(await runEvent('pre-tool-use', edit('pre-edit'))).hookSpecificOutput;
  assert.equal(gate.permissionDecision, 'deny'); assert.match(gate.permissionDecisionReason, /not a person's instruction — constraint \[test-assessment\]: Billing validation active-one/);
  assert.match(gate.permissionDecisionReason, /Source: document review:billing\./); assert(!gate.permissionDecisionReason.includes('proposed-two'));
  assert(!gate.permissionDecisionReason.includes('Explicitly referenced modules'), 'graph locations never hold an edit');
  assert.equal(await runEvent('pre-tool-use', edit('pre-edit')), '', 'the re-issued edit passes');
  assert.equal(await runEvent('pre-tool-use', { ...edit('pre-read'), tool_name: 'Read' }), '');
  assert.equal(await runEvent('pre-tool-use', { ...edit('outside'), tool_input: { file_path: join(base, 'elsewhere.ts') } }), '', 'files outside the repository are ignored');
  const attached = JSON.parse(await runEvent('pre-tool-use', edit('pre-context'), { KURTEL_PRE_EDIT: 'context' })).hookSpecificOutput;
  assert(!attached.permissionDecision); assert.match(attached.additionalContext, /Billing validation active-one/);
  assert.equal(await runEvent('pre-tool-use', edit('pre-off'), { KURTEL_PRE_EDIT: 'off' }), '');
  const after = JSON.parse(await runEvent('post-tool-use', edit('pre-edit'))).hookSpecificOutput.additionalContext;
  assert.match(after, /src\/billing\.ts/); assert(!after.includes('Billing validation'), 'after an edit: graph neighbours and impact, no memory');
  assert.equal(await runEvent('post-tool-use', edit('pre-edit')), '', 'neighbours are delivered once per session');

  // Prompt without a path: scope inferred from the graph, marked, and sent as such to the engine.
  const graph = { ...index, modules: [{ id: 'src/billing.ts', symbols: [{ name: 'validateInvoiceTotals', line: 3, calls: [] }], imports: [], exports: ['validateInvoiceTotals'] }] };
  result = await compactContext(root, graph, 'Fix rounding in validateInvoiceTotals');
  assert.equal(result.scope, 'inferred'); assert.deepEqual(result.paths, ['src/billing.ts']);
  assert.equal(lastRequest.candidates[0].request.path_source, 'inferred');
  assert.match(result.text, /Billing validation active-one/); assert.match(result.text, /task scope inferred from the code graph/);
  // Words joined by a slash are not paths: the scope stays the graph's.
  resetContext(root, 'slash-words');
  result = await compactContext(root, graph, 'Fix rounding in validateInvoiceTotals and/or return application/json', { session: 'slash-words' });
  assert.equal(result.scope, 'inferred'); assert.deepEqual(result.paths, ['src/billing.ts']);
  // A command or a path outside the repository sets no scope and breaks nothing; "./" is the repository.
  resetContext(root, 'dot-paths');
  result = await compactContext(root, graph, 'Fix rounding in validateInvoiceTotals, run ./check_totals and read ../shared/base.yaml', { session: 'dot-paths' });
  assert.equal(result.scope, 'inferred'); assert.deepEqual(result.paths, ['src/billing.ts']);
  assert.deepEqual((await compactContext(root, index, 'inspect ./src/billing.ts')).paths, ['src/billing.ts']);
  // A rule is delivered whole; once delivered in a session it leaves its place to the others.
  const whole = 'Dates are stored in UTC (e.g. 2026-01-05T10:00:00Z), never in local time. ' + 'Convert only when displaying. '.repeat(12);
  appendKnowledge(root, () => ({ ...emptyBatch(), versions: [{ ...version('whole-rule', 'active'), content: whole, zones: ['src/billing.ts'] }] }));
  resetContext(root, 'whole');
  const first = await compactContext(root, index, 'inspect src/billing.ts', { session: 'whole' });
  assert(first.text.includes(whole.trim()), 'a rule is never cut');
  assert.equal(lastRequest.candidates.find(c => c.request.version_id === 'whole-rule').relevance, 0.65, 'a rule on the file itself gets the highest scope bonus, whatever the depth of the file');
  deliverContext(root, 'whole', first.items, first.revision, () => {}, { stillValid: first.stillValid });
  const second = await compactContext(root, index, 'inspect src/billing.ts', { session: 'whole' });
  assert(!second.items.some(i => i.key.startsWith('memory:')), 'delivered rules are not selected again');
  // A follow-up message that names no code keeps the files the session has edited.
  result = await compactContext(root, index, 'No, that is not right yet: three acceptance checks still fail.', { session: 'pre-edit' });
  assert.equal(result.scope, 'inferred'); assert.deepEqual(result.paths, ['src/billing.ts']);
  assert.match(result.text, /task scope inferred from the files edited in this session/);
  // Abstention: one shared word among many is not relevance.
  const before = requests;
  result = await compactContext(root, index, 'Write a monthly billing export with totals per customer and currency');
  assert.equal(result.scope, 'none'); assert(!result.text.includes('Billing validation')); assert.equal(requests, before, 'no engine call without a relevant candidate');

  // Usage journal: an injected item citing a file counts as used once that file is read later.
  await runEvent('post-tool-use', { ...edit('pre-edit'), tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'billing.ts') } });
  const usage = usageReport(root);
  assert(usage.events.PreToolUse.used >= 1 && usage.memory.used >= 1); assert(usage.used_rate > 0);
  assert(!readFileSync(usagePath(root), 'utf8').includes('Billing validation'), 'the usage journal stores keys and paths only');

  // A repository-wide constraint may reach a prompt that cites a path, never hold an edit of an unrelated file.
  appendKnowledge(root, () => ({ ...emptyBatch(), versions: [{ ...version('global-three', 'active'), zones: [], content: 'Unknown customers raise AppError CUSTOMER_NOT_FOUND' }] }));
  assert.match((await compactContext(root, index, 'inspect src/billing.ts')).text, /CUSTOMER_NOT_FOUND/);
  const scopedOnly = JSON.parse(await runEvent('pre-tool-use', edit('pre-global'))).hookSpecificOutput.permissionDecisionReason;
  assert.match(scopedOnly, /active-one/); assert(!scopedOnly.includes('CUSTOMER_NOT_FOUND'));

  // Among rules on the same file, the one the message talks about comes first.
  appendKnowledge(root, () => ({ ...emptyBatch(), versions: [
    { ...version('order-currency', 'active'), zones: ['src/billing.ts'], content: 'Currency codes are upper-case ISO 4217 strings' },
    { ...version('order-refund', 'active'), zones: ['src/billing.ts'], content: 'Refunds are recorded as negative invoice lines, never deleted' }] }));
  await compactContext(root, index, 'In src/billing.ts, record the refund of an invoice paid in several lines');
  const sent = lastRequest.candidates.map(c => c.request.version_id);
  assert.equal(sent[0], 'order-refund'); assert(sent.indexOf('order-currency') > 0, 'the message decides the order among rules on the same file');

  // What a person said about a file outside a guessed scope ranks with what they said about no file.
  const said = (id, content, zones) => ({ sources: [{ id: `capture:${id}`, kind: 'conversation', reference: `claude-code/session/earlier/user-prompt-submit/${id}`, revision: null, recorded_at: now, content: JSON.stringify({ provider: 'claude-code', role: 'user', status: 'observed' }) }],
    events: [{ id: `capture-event:${id}`, kind: 'observation', source_ids: [`capture:${id}`], actor: null, session_id: 'earlier', occurred_at: null, recorded_at: now, content }],
    versions: [{ ...version(id, 'active'), content, zones, source_ids: [`capture:${id}`], event_ids: [`capture-event:${id}`] }] });
  const elsewhere = said('said-elsewhere', 'Ledger exports are signed with the audit key before upload', ['src/ledger.ts']), nowhere = said('said-nowhere', 'Ledger exports are retried twice, then reported', []);
  appendKnowledge(root, () => ({ ...emptyBatch(), sources: [...elsewhere.sources, ...nowhere.sources], events: [...elsewhere.events, ...nowhere.events], versions: [...elsewhere.versions, ...nowhere.versions] }));
  resetContext(root, 'guessed');
  result = await compactContext(root, graph, 'In validateInvoiceTotals, sign the ledger exports with the audit key before the upload', { session: 'guessed' });
  assert.equal(result.scope, 'inferred');
  const relevanceOf = id => lastRequest.candidates.find(c => c.request.version_id === id)?.relevance;
  assert.equal(relevanceOf('said-elsewhere'), 0.75, 'a guessed scope does not put a person\'s rule on another file last');
  assert(relevanceOf('said-nowhere') > 0.25 && relevanceOf('said-nowhere') < 0.75);

  // In a store of twenty rules or more, a rule outside the task's files needs a word that few rules hold.
  const crowd = [...Array.from({ length: 24 }, (_, i) => said(`crowd-${i}`, `Convention ${i}: every report command prints one record per invoice`, [])), said('needle', 'The refund report command numbers its lines with a monotonic counter', [])];
  appendKnowledge(root, () => ({ ...emptyBatch(), sources: crowd.flatMap(x => x.sources), events: crowd.flatMap(x => x.events), versions: crowd.flatMap(x => x.versions) }));
  resetContext(root, 'crowd');
  await compactContext(root, graph, 'In validateInvoiceTotals, print one record per invoice in the refund report command', { session: 'crowd' });
  const crowded = lastRequest.candidates.map(c => c.request.version_id);
  assert(crowded.includes('needle') && !crowded.some(id => id.startsWith('crowd-')), 'common words alone do not bring a rule in');

  // The engine's reading service scores the candidate rules: every rule at or above its line is delivered, whatever
  // their number.
  const report = 'In src/billing.ts, print one record per invoice in the report command';
  const memoryOf = r => r.items.filter(i => i.key.startsWith('memory:'));
  reading = text => /^Convention \d+:/.test(text) ? .8 : .1;
  resetContext(root, 'reading');
  result = await compactContext(root, index, report, { session: 'reading' });
  assert.equal(result.chosen, true); assert.equal(lastReading.message, report); assert(lastReading.rules.includes('Refunds are recorded as negative invoice lines, never deleted'));
  assert.equal(lastRequest.selected, true, 'the engine is told the set is already chosen');
  assert.equal(memoryOf(result).filter(i => /Convention \d+:/.test(i.text)).length, 24, 'twenty-four rules above the line: twenty-four delivered');
  assert(memoryOf(result).length <= 26, 'beyond the line, only the rules linked to the first two');
  assert.equal(result.omitted.length, 0, 'the usual budget does not cut a chosen set');
  // A hook's context is cut by Claude Code beyond 10,000 characters: what does not fit waits for the next message.
  const long = JSON.parse(await runHook('reading-hook', report)).hookSpecificOutput.additionalContext;
  assert(long.length <= 10000 && (long.match(/Convention \d+:/g) ?? []).length >= 12, 'as many chosen rules as the host accepts');
  // Nothing at the line: nothing is delivered, and nothing is asked of the engine.
  reading = () => .1;
  resetContext(root, 'reading-none');
  const asked = requests;
  result = await compactContext(root, index, report, { session: 'reading-none' });
  assert.equal(result.chosen, true); assert.equal(memoryOf(result).length, 0); assert.equal(requests, asked);
  // The best rule is kept from the lower line, and brings the rule closest to it.
  reading = text => text.startsWith('Refunds are recorded') ? .5 : .1;
  resetContext(root, 'reading-low');
  result = await compactContext(root, index, report, { session: 'reading-low' });
  assert(memoryOf(result).some(i => i.text.includes('Refunds are recorded')) && memoryOf(result).length === 2, 'the best rule under the line, with its linked rule');
  assert(memoryOf(result)[0].priority > memoryOf(result)[1].priority || memoryOf(result)[0].text.includes('Refunds are recorded'));
  // A reading service that fails: the selection on words answers, as without it.
  reading = () => 'not a score';
  resetContext(root, 'reading-broken');
  result = await compactContext(root, index, 'inspect src/billing.ts', { session: 'reading-broken' });
  assert.equal(result.chosen, false); assert(memoryOf(result).length > 0 && memoryOf(result).length <= 4);
  reading = null;
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('PASS: pre-edit gate once per file, inferred scope, abstention, pointers, usage journal, lock recovery, token cap, graph-only default, omission without truncation, retry/dedup/reset, revision invalidation, scoped hybrid retrieval, one minimized HTTP batch, investigation and safe degradation.');
