// A space (a team's memory, not a code repository): dated facts, a fact replaced by a newer one, a temporary
// exception delivered with the rule it suspends. Provisional switch: KURTEL_MEMORY_SPACE=1.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const fixture = mkdtempSync(join(tmpdir(), 'kurtel-space-'));
const root = join(fixture, 'repo'), home = join(fixture, 'home'); mkdirSync(root); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { activateRepo, memorySpace } = await import('../dist/storage/state.js');
delete process.env.KURTEL_MEMORY_SPACE;
const { captureHook, setCaptureEnabled } = await import('../dist/integrations/claude-code/capture.js');
const { readKnowledge, activeRules, linkedRules } = await import('../dist/storage/knowledge.js');
const { configureLearning, learnSession } = await import('../dist/memory/session-learning.js');
const { reactivateRule, replacedRules } = await import('../dist/memory/rule-links.js');
const { storedValidity, validityDays, inForce, isDay } = await import('../dist/memory/validity.js');
const { pendingOperations, adoptRecords } = await import('../dist/memory/shared.js');
const { compactContext } = await import('../dist/context/compact.js');

const day = offset => { const t = new Date(); t.setDate(t.getDate() + offset); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

// 1. Days, both included, become instants, the last one excluded, and back.
const period = storedValidity('2026-08-01', '2026-08-31');
assert.equal(new Date(period.valid_from).getDate(), 1); assert.equal(new Date(period.valid_until).getMonth(), 8, 'ends at the midnight that starts 1 September');
assert.deepEqual(validityDays(period), { valid_from: '2026-08-01', valid_until: '2026-08-31' });
assert(inForce(period, Date.parse(period.valid_until) - 1) && !inForce(period, Date.parse(period.valid_until)) && !inForce(period, Date.parse(period.valid_from) - 1));
assert.deepEqual(storedValidity('2026-09-01', '2026-08-01'), { valid_from: null, valid_until: null }, 'a period backwards is none');
assert.deepEqual(storedValidity('2026-02-30', 'end of June'), { valid_from: null, valid_until: null });
assert(!isDay('2026-02-30') && isDay('2026-02-28'));
assert.deepEqual(validityDays({ valid_from: null, valid_until: null }), {});

// The engine: one candidate per batch, the last user message, with the days the test gives it.
const days = new Map(), extracted = [], links = [];
let answer = () => ({ linked: [], replaced: [], exceptions: [] });
const server = createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  const body = JSON.parse(text);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/embed' || req.url === '/v1/rank') { res.writeHead(501); res.end('{}'); return; }
  if (req.url === '/v1/link') { links.push(body); res.end(JSON.stringify({ protocol: 1, ...answer(body) })); return; }
  // As the engine: an active rule is eligible (its dates are left to the CLI here).
  if (req.url === '/v1/context') { res.end(JSON.stringify({ protocol: 1, evaluations: body.candidates.map(c => ({ version_id: c.request.version_id, eligible: c.request.store.versions.find(v => v.id === c.request.version_id).state === 'active', reasons: ['test'], rank: 3 })) })); return; }
  // Correction checks: no answer, the CLI does without.
  if (req.url !== '/v1/extract') { res.writeHead(501); res.end('{}'); return; }
  extracted.push(body);
  const event = body.events.filter(e => e.role === 'user').at(-1), d = days.get(event.content) ?? {};
  res.end(JSON.stringify({ protocol: 1, engine: 'test', batch_id: body.batch_id, candidates: [{ event_id: event.id, quote: event.content, kind: 'fact', zones: [], reason_event_id: null, reason_quote: null, ...(body.space ? { valid_from: d.from ?? null, valid_until: d.until ?? null } : {}) }], working: [] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
activateRepo(root); setCaptureEnabled(root, true);
configureLearning(root, `http://127.0.0.1:${server.address().port}/v1/extract`);
process.env.KURTEL_ENGINE_TOKEN = 'test-token';
let n = 0;
const learn = async (prompt, d) => { if (d) days.set(prompt, d); const sid = `s${++n}`; captureHook(root, 'user-prompt-submit', { session_id: sid, prompt_id: 'p', prompt }); await learnSession(root, sid); return readKnowledge(root).versions.findLast(v => v.content === prompt); };
const head = knowledgeId => readKnowledge(root).versions.filter(v => v.knowledge_id === knowledgeId).reduce((a, v) => v.version > a.version ? v : a);
const delivered = async prompt => (await compactContext(root, null, prompt, { session: `ask${++n}` })).items.map(i => i.text).join('\n');

try {
  // 2. A code repository: nothing new is sent, and the engine's days, if any, are not asked for.
  assert.equal(memorySpace(), false);
  const oldLine = await learn("Le numéro d'astreinte est le 02 55 01 01 47.");
  await learn('Marc valide les commandes de sondes.');
  assert(extracted.every(b => !('space' in b) && !('date' in b)), 'code mode: no space, no date');
  assert(links.length && links.every(b => !('space' in b) && b.candidates.every(c => !('valid_from' in c) && !('valid_until' in c))));
  assert.equal(oldLine.valid_from, null); assert.equal(oldLine.valid_until, null);

  // 3. A space: the request carries the day; a fact that replaces another supersedes it.
  process.env.KURTEL_MEMORY_SPACE = 'yes'; assert.equal(memorySpace(), false, 'only 1 turns it on');
  process.env.KURTEL_MEMORY_SPACE = '1';
  answer = body => ({ linked: [], replaced: body.rule.text.includes('09 12') ? body.candidates.filter(c => c.text.includes('01 47')).map(c => c.id) : [], exceptions: [] });
  const newLine = await learn("Le numéro d'astreinte est désormais le 02 55 01 09 12.");
  assert.equal(extracted.at(-1).space, true); assert.equal(extracted.at(-1).date, day(0));
  assert.equal(links.at(-1).space, true);
  assert.equal(head(oldLine.knowledge_id).state, 'superseded');
  const supersedes = readKnowledge(root).relations.filter(r => r.kind === 'supersedes');
  assert.equal(supersedes.length, 1); assert.equal(supersedes[0].from.id, newLine.id); assert.equal(supersedes[0].to.id, oldLine.id);
  assert(!activeRules(root, 'none').some(r => r.knowledge_id === oldLine.knowledge_id), 'a replaced fact is no longer a rule to deliver');
  assert.deepEqual(replacedRules(readKnowledge(root)).map(v => v.knowledge_id), [oldLine.knowledge_id]);
  assert.doesNotMatch(await delivered("Quel est le numéro d'astreinte ?"), /01 47/);

  // 4. A wrong replacement is undone: the old fact is active again, the history keeps both.
  assert.throws(() => reactivateRule(root, 'nothing-like-this'), /No replaced rule/);
  // A duplicate the shared memory merged away is superseded with no newer fact: it is not offered.
  const merged = { ...oldLine, id: 'version:merged', knowledge_id: 'merged', version: 2, state: 'superseded' };
  assert.deepEqual(replacedRules({ versions: [merged], relations: [] }), []);
  const back = reactivateRule(root, oldLine.knowledge_id.slice(0, 20));
  assert.equal(back.state, 'active'); assert.equal(head(oldLine.knowledge_id).state, 'active');
  assert.deepEqual(replacedRules(readKnowledge(root)), []);
  assert(readKnowledge(root).versions.some(v => v.knowledge_id === oldLine.knowledge_id && v.state === 'superseded'), 'history kept');

  // 5. A temporary exception holds until its last day, goes with the rule it suspends, which is not retired.
  const marc = readKnowledge(root).versions.find(v => v.content.startsWith('Marc valide'));
  answer = body => ({ linked: [], replaced: [], exceptions: body.rule.text.includes('Julie') ? body.candidates.filter(c => c.text.startsWith('Marc')).map(c => c.id) : [] });
  const julie = await learn("Jusqu'à demain, c'est Julie qui valide les commandes de sondes.", { until: day(1) });
  assert.equal(links.at(-1).rule.valid_until, day(1), 'the engine sees the period of the new fact');
  assert.deepEqual(validityDays(julie), { valid_until: day(1) });
  assert.equal(head(marc.knowledge_id).state, 'active');
  assert(readKnowledge(root).relations.some(r => r.kind === 'exception_to' && r.from.id === julie.id && r.to.id === marc.id));
  assert(linkedRules(root).some(([a, b]) => a === julie.knowledge_id && b === marc.knowledge_id), 'delivered together');
  assert.match(await delivered('Qui valide les commandes de sondes ?'), /Julie/);

  // 6. Not delivered before its first day, nor after its last.
  answer = () => ({ linked: [], replaced: [], exceptions: [] });
  await learn('À partir du mois prochain, les devis de turbidité passent par le comité.', { from: day(30) });
  await learn('Hier encore, les devis de chlore passaient par Samuel.', { until: day(-1) });
  const later = await delivered('Qui valide les devis de turbidité ?'), ended = await delivered('Qui valide les devis de chlore ?');
  assert.doesNotMatch(later, /turbidité passent/); assert.doesNotMatch(ended, /chlore passaient/);
  assert.match(await delivered('Qui valide les commandes de sondes Marc ?'), /Marc valide/, 'an undated fact is delivered');

  // 7. Shared: a dated fact is sent with its period, an undated one as before; a teammate's period is kept.
  const store = readKnowledge(root), ops = pendingOperations(store, { enabled: true, endpoint: 'https://x', repo: 'r', cursor: 0, pushed: [], adopted: [] }).operations.filter(o => o.type === 'learn');
  const sent = id => ops.find(o => o.knowledge_id === id)?.version;
  assert.equal(sent(julie.knowledge_id).valid_until, julie.valid_until); assert(!('valid_from' in sent(julie.knowledge_id)));
  assert(!('valid_from' in sent(marc.knowledge_id)) && !('valid_until' in sent(marc.knowledge_id)));
  const record = (id, extra) => ({ type: 'version', record: { id: `version:${id}`, knowledge_id: id, kind: 'fact', state: 'active', content: `Teammate fact ${id}`, zones: [], event_ids: [], actor: 'bob', recorded_at: new Date().toISOString(), ...extra } });
  const { batch } = adoptRecords(store, 'r', [record('dated', { valid_until: julie.valid_until }), record('odd', { valid_from: 'tomorrow' })]);
  assert.equal(batch.versions.find(v => v.knowledge_id === 'dated').valid_until, julie.valid_until);
  assert.equal(batch.versions.find(v => v.knowledge_id === 'odd').valid_from, null, 'not an instant: dropped');
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('PASS: space switch, validity days, supersession, reactivation, temporary exception, delivery within the period, shared periods, code path unchanged.');
