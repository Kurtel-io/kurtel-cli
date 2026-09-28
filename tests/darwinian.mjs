import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const base = mkdtempSync(join(tmpdir(), 'kurtel-darwinian-'));
const root = join(base, 'repo'), home = join(base, 'home'); mkdirSync(root); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { appendKnowledge, emptyBatch } = await import('../dist/storage/knowledge.js');
const { evaluationRequest } = await import('../dist/memory/darwinian.js');
const now = new Date().toISOString();
const version = id => ({ id, knowledge_id: id, version: 1, previous_version_id: null, kind: 'constraint', state: 'active', content: 'CONFIDENTIAL CONTENT', zones: ['src'], source_ids: ['proof'], event_ids: [], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null });
// Automatic-memory events: a confirmation and a correction of the same knowledge, each from a captured message.
const event = (id, data) => ({ id, kind: 'observation', source_ids: ['proof'], actor: 'developer:alice', session_id: 's1', occurred_at: null, recorded_at: now, content: JSON.stringify({ ...data, note: 'PRIVATE NOTE' }) });
appendKnowledge(root, () => ({ ...emptyBatch(),
  sources: [{ id: 'proof', kind: 'conversation', reference: 'session:s1', revision: '1', content: 'PRIVATE SOURCE TEXT', recorded_at: now }],
  versions: [version('general'), version('exception')],
  events: [event('confirm:1', { protocol: 'kurtel-confirmation-v1', knowledge_id: 'general', version_id: 'general', session: 's1', turn: 't1' }),
    event('correction:1', { protocol: 'kurtel-correction-v1', session: 's1', turn: 't2', contradicted: ['general'] })],
  relations: [{ id: 'exception-rel', kind: 'exception_to', from: { type: 'version', id: 'exception' }, to: { type: 'version', id: 'general' }, source_ids: ['proof'], recorded_at: now, valid_from: null, valid_until: null }],
}));
const request = evaluationRequest(root, 'general', ['src/file.ts']);
assert.equal(request.store.events.length, 1, 'the confirmation of this knowledge is sent for scoring');
const text = JSON.stringify(request);
for (const secret of ['CONFIDENTIAL CONTENT', 'PRIVATE SOURCE TEXT', 'PRIVATE NOTE', 'developer:alice']) assert(!text.includes(secret), `${secret} stays local`);
assert(request.store.relations.some(r => r.id === 'exception-rel'), 'related versions are part of the assessment');
console.log('PASS: minimized scoring payload — no knowledge, source or note text, no actor; confirmations and relations kept.');
