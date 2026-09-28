import { createServer } from 'node:http';

// Stand-in for the learning engine in tests; KURTEL_TEST_ENGINE runs them against a real one.
const json = text => { try { return JSON.parse(text); } catch { return null; } };
function hardness(version, events) {
  const turns = new Set(), sessions = new Set();
  for (const e of events) {
    const d = json(e.content);
    if (d?.protocol === 'kurtel-confirmation-v1' && d.knowledge_id === version.knowledge_id) { turns.add(d.turn); sessions.add(d.session); }
  }
  const origin = events.find(e => version.event_ids.includes(e.id) && json(e.content)?.protocol === 'kurtel-correction-v1');
  if (origin) sessions.add(json(origin.content).session);
  const c = turns.size + (origin ? 2 : 0), confidence = c / (c + 2);
  return { confidence, hard: confidence >= .6 && sessions.size >= 2 };
}

export function createEngineServer({ token, model, correctionModel = model }) {
  return createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, {});
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/v1/context') {
        return reply(200, { protocol: 1, evaluations: input.candidates.map(c => {
          const v = c.request.store.versions.find(v => v.id === c.request.version_id);
          const contradicted = c.request.store.events.some(e => {
            try { const data = JSON.parse(e.content); return data.version_id === v.id && data.signal === 'contradicted'; } catch { return false; }
          });
          const h = hardness(v, c.request.store.events);
          const eligible = v.state === 'active' && !contradicted;
          const notHard = eligible && input.phase === 'pre_edit' && !h.hard;
          return { version_id: v.id, eligible: eligible && !notHard, rank: 10 + h.confidence * 2 + (h.hard ? 2 : 0), reasons: contradicted ? ['unresolved_contradiction'] : notHard ? ['not_hard_pre_edit'] : v.state === 'active' ? ['current_active_in_scope'] : [`state_${v.state}`] };
        }) });
      }
      if (req.url === '/v1/correction') {
        if (input?.protocol !== 1 || typeof input.message !== 'string' || !Array.isArray(input.rules)) return reply(400, {});
        const out = await correctionModel('', { message: input.message, rules: input.rules, agent_turn: input.context ?? { agent_edited_files: [], agent_ran_commands: 0 } });
        return reply(200, { protocol: 1, correction: !!out.correction, contradicted: out.correction ? out.contradicted ?? [] : [], explanation: out.correction ? out.explanation ?? null : null });
      }
      if (!['/v1/extract', '/v1/lessons'].includes(req.url)) return reply(404, {});
      reply(200, { protocol: 1, batch_id: input.batch_id, engine: 'protocol-fixture', ...await model('', input) });
    } catch { reply(502, {}); }
  });
}
