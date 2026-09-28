import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixture = mkdtempSync(join(tmpdir(), 'kurtel-history-'));
const home = join(fixture, 'home'), root = join(fixture, 'repo');
mkdirSync(home); mkdirSync(root);
process.env.HOME = home; process.env.USERPROFILE = home;
const { appendKnowledge, readKnowledge, knowledgePath, emptyBatch } = await import('../dist/storage/knowledge.js');
const { explainKnowledge, knowledgeHistory } = await import('../dist/memory/knowledge-history.js');
// Fixture: a state transition as the automatic memory records one (new version, sourced event, carried relations).
let seq = 0;
const changeKnowledgeState = (root, versionId, state, sourceId, reason, replacementId) => appendKnowledge(root, current => {
  const previous = current.versions.find(v => v.id === versionId), now = new Date().toISOString(), n = ++seq;
  const id = `version:t${n}`, eventId = `state:t${n}`, batch = emptyBatch();
  batch.events.push({ id: eventId, kind: 'instruction', source_ids: [sourceId], actor: null, session_id: null, occurred_at: now, recorded_at: now, content: `State ${previous.state} -> ${state}: ${reason}` });
  batch.versions.push({ ...previous, id, version: previous.version + 1, previous_version_id: previous.id, state, source_ids: [...new Set([...previous.source_ids, sourceId])], event_ids: [...previous.event_ids, eventId], recorded_at: now });
  for (const r of current.relations) if ((r.from.type === 'version' && r.from.id === previous.id) || (r.to.type === 'version' && r.to.id === previous.id)) {
    const replace = ref => ref.type === 'version' && ref.id === previous.id ? { ...ref, id } : ref;
    batch.relations.push({ ...r, id: `relation:t${n}:${r.id}`, from: replace(r.from), to: replace(r.to), recorded_at: now, source_ids: [...new Set([...r.source_ids, sourceId])] });
  }
  if (replacementId) batch.relations.push({ id: `relation:t${n}:replacement`, kind: 'supersedes', from: { type: 'version', id: replacementId }, to: { type: 'version', id }, source_ids: [sourceId], recorded_at: now, valid_from: now, valid_until: null });
  return batch;
});
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, 'knowledge', ...args], { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true });
const recorded = '2026-01-01T00:00:00.000Z';
const source = (id, content) => ({ id, kind: 'document', reference: `docs/${id}.md`, revision: 'commit:abc', content, recorded_at: recorded });
const version = (id, content, kind = 'decision') => ({ id: `${id}:v1`, knowledge_id: id, version: 1, previous_version_id: null, kind, state: 'active', content, zones: ['payments'], source_ids: ['policy'], event_ids: [], recorded_at: recorded, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null });
const relation = (id, kind, from, to) => ({ id, kind, from: { type: 'version', id: from }, to: { type: 'version', id: to }, source_ids: ['policy'], recorded_at: recorded, valid_from: null, valid_until: null });
const batch = emptyBatch();
batch.sources.push(source('policy', 'Le contrat interdit les appels externes.'), source('approval', 'La décision est contestée après un incident.'), source('pr', null));
batch.versions.push(version('gateway', 'Utiliser la passerelle interne.'), version('network', 'Interdire les appels externes.', 'constraint'), version('contract', 'Respecter le contrat client.', 'constraint'), version('incident', 'La passerelle interne a échoué hors ligne.', 'counterexample'), version('external', 'API externe rejetée.', 'rejected_alternative'), version('unknown', 'Utiliser le format binaire.'), version('next', 'Utiliser le nouveau service interne.'));
batch.relations.push(relation('why-network', 'motivated_by', 'gateway:v1', 'network:v1'), relation('why-contract', 'motivated_by', 'network:v1', 'contract:v1'), relation('failure', 'contradicts', 'incident:v1', 'gateway:v1'), relation('alternative', 'alternative_to', 'external:v1', 'gateway:v1'));
batch.relations.push({ ...relation('support-only', 'supported_by', 'unknown:v1', 'pr'), to: { type: 'source', id: 'pr' } });
appendKnowledge(root, () => batch);
let store = readKnowledge(root);
let result = explainKnowledge(store, 'gateway');
assert.equal(result.status, 'explained');
assert.deepEqual(result.reasons.map(e => e.relation.id), ['why-network', 'why-contract']);
assert.equal(result.counterexamples[0].from.record.kind, 'counterexample');
assert.equal(result.alternatives[0].from.record.kind, 'rejected_alternative');
assert.equal(result.sources[0].reference, 'docs/policy.md');
assert.equal(explainKnowledge(store, 'Pourquoi la passerelle interne ?').status, 'ambiguous');
assert.equal(explainKnowledge(store, 'Pourquoi utiliser la passerelle interne ?').selected.id, 'gateway:v1');
assert.equal(explainKnowledge(store, 'payments').status, 'ambiguous');
assert.equal(explainKnowledge(store, 'Redis').status, 'not_found');
assert.equal(explainKnowledge(store, 'unknown').status, 'missing_reason', 'support does not imply causation');
assert.equal(explainKnowledge(store, 'gateway', { depth: 1 }).truncated, true);
assert.throws(() => explainKnowledge(store, 'gateway', { depth: 0 }), /Depth/);
assert.throws(() => explainKnowledge(store, 'gateway', { at: 'bad date' }), /date/);
assert.equal(explainKnowledge(store, 'gateway', { at: '2025-01-01T00:00:00Z' }).status, 'not_found');

// Cycles are explicit and bounded; expired relations cannot explain a decision now.
appendKnowledge(root, () => ({ ...emptyBatch(), relations: [relation('cycle', 'motivated_by', 'contract:v1', 'gateway:v1'), { ...relation('expired', 'motivated_by', 'unknown:v1', 'contract:v1'), valid_until: '2026-02-01T00:00:00Z' }] }));
store = readKnowledge(root);
assert.deepEqual(explainKnowledge(store, 'gateway').cycles, ['cycle']);
assert.equal(explainKnowledge(store, 'unknown').status, 'missing_reason');
assert.equal(explainKnowledge(store, 'unknown', { at: '2026-01-15T00:00:00Z' }).status, 'explained');

const changed = changeKnowledgeState(root, 'gateway:v1', 'contested', 'approval', 'Incident en mode hors ligne');
const contested = changed.versions.at(-1);
assert.equal(contested.state, 'contested');
assert.equal(changed.versions.find(v => v.id === 'gateway:v1').state, 'active');
assert.equal(explainKnowledge(changed, 'gateway').selected.state, 'contested');
assert.equal(explainKnowledge(changed, 'gateway').counterexamples.length, 1);
assert.equal(explainKnowledge(changed, 'gateway').reasons[0].to.id, 'network:v1');
assert.equal(explainKnowledge(changed, 'gateway:v1').historical_version, true);
assert.equal(explainKnowledge(changed, 'gateway', { at: '2026-01-15T00:00:00Z' }).selected.state, 'active');
const replaced = changeKnowledgeState(root, contested.id, 'superseded', 'approval', 'Nouveau service', 'next:v1');
assert.equal(explainKnowledge(replaced, 'gateway').selected.state, 'superseded');
assert.equal(explainKnowledge(replaced, 'gateway').replacements[0].from.id, 'next:v1');
const history = knowledgeHistory(replaced, 'gateway');
assert.deepEqual(history.versions.map(v => v.state), ['active', 'contested', 'superseded']);
assert(history.events.some(e => e.content.includes('Incident en mode hors ligne')));
assert(history.sources.some(s => s.id === 'approval'));

for (const action of ['why', 'history', 'counterexamples']) {
  const execution = run(action, 'gateway', '--json');
  assert.equal(execution.status, 0, execution.stderr);
  assert(JSON.parse(execution.stdout));
}
const text = run('why', 'gateway');
assert.equal(text.status, 0, text.stderr);
assert.match(text.stdout, /superseded/);
assert.match(text.stdout, /docs\/policy.md/);
assert.match(text.stdout, /API externe rejetée/);
assert.match(run('why', 'unknown').stdout, /Reason unknown/);
assert.match(run('counterexamples', 'unknown').stdout, /does not prove there is none/);
assert.notEqual(run('state', 'gateway:v1').status, 0, 'manual state changes are retired');
console.log('PASS: sourced why chains, missing reasons, ambiguity, cycles, temporal queries, alternatives, counterexamples, history across state transitions and CLI.');
