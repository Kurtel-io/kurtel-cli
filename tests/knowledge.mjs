import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = mkdtempSync(join(tmpdir(), 'kurtel-knowledge-'));
const home = join(fixture, 'home');
const root = join(fixture, 'repo');
mkdirSync(home); mkdirSync(root);
process.env.USERPROFILE = home;
process.env.HOME = home;
const { appendKnowledge, emptyBatch, readKnowledge, knowledgePath, knowledgeScope, closeKnowledge } = await import('../dist/storage/knowledge.js');
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, 'knowledge', ...args], { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true });

assert.equal(run('status').status, 0);
assert.equal(existsSync(knowledgePath(root)), false, 'reading an untouched repo creates nothing');

// Native decision + evidence + causal relation, committed together.
const now = '2026-09-18T14:00:00.000Z';
const batch = emptyBatch();
batch.sources.push({ id: 'source:discussion', kind: 'conversation', reference: 'session:1/message:4', revision: '4', content: 'Use the internal gateway because external network access is forbidden.', recorded_at: now });
batch.events.push({ id: 'event:instruction', kind: 'instruction', source_ids: ['source:discussion'], actor: 'developer:alice', session_id: 'session:1', occurred_at: now, recorded_at: now, content: 'Use the internal gateway.' });
batch.versions.push({ id: 'decision:v1', knowledge_id: 'gateway', version: 1, previous_version_id: null, kind: 'decision', state: 'active', content: 'Use the internal gateway.', zones: ['src/integrations'], source_ids: ['source:discussion'], event_ids: ['event:instruction'], recorded_at: now, valid_from: now, valid_until: null, legacy_pattern_id: null, legacy_score: null });
batch.relations.push({ id: 'reason:gateway', kind: 'motivated_by', from: { type: 'version', id: 'decision:v1' }, to: { type: 'source', id: 'source:discussion' }, source_ids: ['source:discussion'], recorded_at: now, valid_from: now, valid_until: null });
appendKnowledge(root, () => batch);
const snapshot = JSON.stringify(readKnowledge(root));
appendKnowledge(root, () => batch);
assert.equal(JSON.stringify(readKnowledge(root)), snapshot);
assert.throws(() => appendKnowledge(root, () => emptyBatch(), 0), /revision conflict/);
assert.throws(() => appendKnowledge(root, () => ({ ...emptyBatch(), sources: [{ ...batch.sources[0], content: 'Rewrite history' }] })), /Immutable/);
assert.throws(() => appendKnowledge(root, () => ({ ...emptyBatch(), relations: [{ ...batch.relations[0], id: 'dangling', to: { type: 'version', id: 'missing' } }] })), /dangling/);
assert.throws(() => appendKnowledge(root, () => ({ ...emptyBatch(), versions: [{ ...batch.versions[0], id: 'fork', version: 3 }] })), /version chain/);
assert.equal(JSON.stringify(readKnowledge(root)), snapshot, 'failed transactions leave disk intact');
assert.equal(existsSync(knowledgePath(root) + '.lock'), false);

// Concurrent writers: preparing a write holds no lock, so another process writes meanwhile; the first writer
// sees its snapshot is stale and prepares again on the new state: nothing is lost, nobody waits.
writeFileSync(join(fixture, 'snapshot.json'), snapshot);
const extra = JSON.parse(snapshot);
extra.sources.push({ id: 'source:concurrent', kind: 'document', reference: 'other-process', revision: null, content: null, recorded_at: now });
writeFileSync(join(fixture, 'concurrent.json'), JSON.stringify(extra));
let prepared = 0;
appendKnowledge(root, current => {
  prepared++;
  if (prepared === 1) assert.equal(run('import', join(fixture, 'concurrent.json')).status, 0, 'the other process is not blocked');
  return { ...emptyBatch(), sources: [{ id: 'source:mine', kind: 'document', reference: current.sources.some(s => s.id === 'source:concurrent') ? 'after-other' : 'before-other', revision: null, content: null, recorded_at: now }] };
});
assert.equal(prepared, 2, 'prepared again on the new state');
assert.equal(readKnowledge(root).sources.find(s => s.id === 'source:mine').reference, 'after-other');
assert(readKnowledge(root).sources.some(s => s.id === 'source:concurrent'), 'both writes kept');
// A writer announcing itself with a lock file (older CLI) is still refused, not interleaved.
writeFileSync(knowledgePath(root) + '.lock', 'older writer');
assert.match(run('import', join(fixture, 'snapshot.json')).stderr, /locked/);
unlinkSync(knowledgePath(root) + '.lock');
assert.equal(run('import', join(fixture, 'snapshot.json')).status, 0);
assert.deepEqual(JSON.parse(run('export').stdout), readKnowledge(root));
const other = join(fixture, 'other', 'repo');
mkdirSync(other, { recursive: true });
assert.notEqual(knowledgeScope(root), knowledgeScope(other));
assert.equal(readKnowledge(other).sources.length, 0);
const cross = spawnSync(process.execPath, [cli, 'knowledge', 'import', join(fixture, 'snapshot.json')], { cwd: other, env: process.env, encoding: 'utf8', windowsHide: true });
assert.notEqual(cross.status, 0);
assert.match(cross.stderr, /scope mismatch/);

// A corrupted database is refused, never replaced by an empty writable store.
const beforeCorruption = JSON.stringify(readKnowledge(root));
closeKnowledge();
const database = readFileSync(knowledgePath(root));
writeFileSync(knowledgePath(root), Buffer.from('not a database'.padEnd(4096, '#')));
assert.throws(() => readKnowledge(root));
assert.equal(readFileSync(knowledgePath(root), 'latin1').startsWith('not a database'), true, 'left as found');
closeKnowledge();
writeFileSync(knowledgePath(root), database);
assert.equal(JSON.stringify(readKnowledge(root)), beforeCorruption);
console.log('Knowledge v2: history, evidence, integrity, isolation, locking and corruption checks passed.');
