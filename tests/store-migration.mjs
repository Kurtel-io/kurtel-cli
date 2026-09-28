// SQLite store: an existing store.json is imported once, validated, and kept aside;
// a broken one is refused, never replaced by an empty store.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'kurtel-migration-'));
const home = join(temp, 'home'); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { appendKnowledge, readKnowledge, knowledgePath, knowledgeScope, currentVersions, emptyBatch } = await import('../dist/storage/knowledge.js');

const now = '2026-09-26T10:00:00.000Z';
const record = (id, knowledge, version, state, previous = null) => ({ id, knowledge_id: knowledge, version, previous_version_id: previous, kind: 'constraint', state, content: `rule ${knowledge}`, zones: ['src/pay.ts'], source_ids: ['doc'], event_ids: [], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null });
const legacyStore = root => ({ schema_version: 2, scope: knowledgeScope(root), revision: 7, relations: [],
  sources: [{ id: 'doc', kind: 'document', reference: 'seed', revision: null, content: null, recorded_at: now }],
  events: [{ id: 'confirm:1', kind: 'observation', source_ids: ['doc'], actor: null, session_id: 's1', occurred_at: null, recorded_at: now, content: JSON.stringify({ protocol: 'kurtel-confirmation-v1', knowledge_id: 'k1', version_id: 'v1', session: 's1', turn: 't1' }) }],
  versions: [record('v1', 'k1', 1, 'active'), record('v2', 'k2', 1, 'active'), record('v3', 'k2', 2, 'contested', 'v2')] });

// 1. Import on first open: same content, same revision, JSON kept aside, heads index filled.
const root = join(temp, 'repo'); mkdirSync(root);
const legacy = join(dirname(knowledgePath(root)), 'store.json');
mkdirSync(dirname(legacy), { recursive: true });
writeFileSync(legacy, JSON.stringify(legacyStore(root)));
assert.deepEqual(readKnowledge(root), legacyStore(root));
assert(existsSync(knowledgePath(root)) && !existsSync(legacy) && existsSync(legacy + '.imported'));
assert.deepEqual(currentVersions(root).map(v => [v.knowledge_id, v.state]), [['k1', 'active'], ['k2', 'contested']]);
assert.deepEqual(currentVersions(root, 'active').map(v => v.id), ['v1']);
appendKnowledge(root, current => ({ ...emptyBatch(), versions: [record('v4', 'k1', 2, 'archived', 'v1')] }));
assert.equal(readKnowledge(root).revision, 8);
assert.deepEqual(currentVersions(root, 'active'), []);

// 2. A broken JSON store is refused on every attempt, and left as found.
const broken = join(temp, 'broken'); mkdirSync(broken);
const brokenLegacy = join(dirname(knowledgePath(broken)), 'store.json');
mkdirSync(dirname(brokenLegacy), { recursive: true });
writeFileSync(brokenLegacy, '{"schema_version":2,');
assert.throws(() => readKnowledge(broken));
assert.throws(() => appendKnowledge(broken, () => emptyBatch()));
assert.equal(readFileSync(brokenLegacy, 'utf8'), '{"schema_version":2,');

// 3. A store of another repository path is refused.
const moved = join(temp, 'moved'); mkdirSync(moved);
const movedLegacy = join(dirname(knowledgePath(moved)), 'store.json');
mkdirSync(dirname(movedLegacy), { recursive: true });
writeFileSync(movedLegacy, JSON.stringify(legacyStore(root)));
assert.throws(() => readKnowledge(moved), /scope mismatch/);

console.log('PASS: SQLite store — JSON store imported once with its revision and kept aside, heads index, broken or foreign JSON store refused and left as found.');
