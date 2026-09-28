import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

// Stand-in for the shared knowledge server in tests; KURTEL_TEST_SHARED runs them against a real one.
export async function createSharedServer({ tokens }) {
  const bodies = [];
  let handle, service;
  const rows = [];
  if (process.env.KURTEL_TEST_SHARED) {
    const { createMemoryService, createFileMemoryStore } = await import(new URL(`file:///${process.env.KURTEL_TEST_SHARED.replace(/\\/g, '/')}`).href);
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    service = createMemoryService({ store: await createFileMemoryStore(join(mkdtempSync(join(tmpdir(), 'kurtel-shared-')), 'records.jsonl')) });
    handle = (actor, body) => service.handle({ scope: 'org:test', actor, write: true }, body);
  } else {
    const head = (repo, k) => rows.filter(r => r.repo === repo && r.type === 'version' && r.record.knowledge_id === k).at(-1)?.record;
    const add = (repo, type, record) => rows.push({ repo, type, record, seq: rows.length + 1 });
    handle = async (actor, body) => {
      if (body.action === 'pull') {
        const page = rows.filter(r => r.repo === body.repo && r.seq > body.since).slice(0, 500);
        return { protocol: 1, records: page.map(({ seq, type, record }) => ({ seq, type, record })), cursor: page.at(-1)?.seq ?? body.since, more: false };
      }
      const results = body.operations.map(op => {
        const exists = id => rows.some(r => r.repo === body.repo && r.record.id === id);
        if (op.type === 'event') { if (exists(op.event.id)) return 'duplicate'; add(body.repo, 'event', { ...op.event, actor, kind: 'observation' }); return 'applied'; }
        const h = head(body.repo, op.knowledge_id);
        if (op.type === 'learn') {
          if (h) return 'duplicate';
          const record = { ...op.version, knowledge_id: op.knowledge_id, version: 1, previous_version_id: null, event_ids: op.event_ids, origin: op.origin, actor, author: actor };
          add(body.repo, 'version', record);
          // Same text: merged.
          const norm = t => t.replace(/\s+/g, ' ').trim().replace(/[.!;:,\s]+$/, '').toLowerCase();
          const knowledge = [...new Set(rows.filter(r => r.repo === body.repo && r.type === 'version').map(r => r.record.knowledge_id))];
          const target = knowledge.map(k => head(body.repo, k)).find(t => t.knowledge_id !== op.knowledge_id && t.state === 'active' && norm(t.content) === norm(record.content));
          if (target) {
            add(body.repo, 'version', { ...record, id: `${record.id}:merged`, version: 2, previous_version_id: record.id, state: 'superseded', merged_into: target.knowledge_id });
            add(body.repo, 'version', { ...target, id: `${target.id}:merge`, version: target.version + 1, previous_version_id: target.id, zones: [...new Set([...target.zones, ...record.zones])], event_ids: [...new Set([...target.event_ids, ...record.event_ids])], merged_from: [{ knowledge_id: op.knowledge_id, author: actor }] });
          }
          return 'applied';
        }
        if (!h || exists(op.version.id)) return h ? 'duplicate' : 'ignored';
        if (h.state !== 'active') return 'ignored';
        const id = h.id === op.from_version_id ? op.version.id : `version:${createHash('sha256').update(`${h.id}:${op.version.id}`).digest('hex')}`;
        add(body.repo, 'version', { ...h, ...op.version, id, version: h.version + 1, previous_version_id: h.id, event_ids: [...new Set([...h.event_ids, ...op.event_ids])], actor, recorded_at: new Date().toISOString() });
        return 'applied';
      });
      return { protocol: 1, results };
    };
  }
  // As the GitHub webhook does on a merged pull request.
  let anchorMerge;
  if (process.env.KURTEL_TEST_SHARED) anchorMerge = merge => service.anchorMerge(merge);
  else anchorMerge = async ({ repo, branch, commit, mergedAt }) => {
    const learned = rows.filter(r => r.repo === repo && r.type === 'version' && r.record.version === 1 && r.record.origin?.branch === branch && Date.parse(r.record.origin.learned_at) <= Date.parse(mergedAt));
    for (const r of learned) rows.push({ repo, type: 'event', seq: rows.length + 1, record: { id: `anchor:${r.record.knowledge_id}:${commit}`, recorded_at: new Date().toISOString(), actor: 'github', kind: 'observation', data: { protocol: 'kurtel-anchor-v1', knowledge_id: r.record.knowledge_id, commit, branch, via: 'merge' } } });
    return learned.length;
  };
  const server = createServer(async (req, res) => {
    const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const actor = tokens[(req.headers.authorization ?? '').replace(/^Bearer /, '')];
    if (!actor) return reply(401, { error: 'invalid' });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'); bodies.push(raw);
    try { reply(200, await handle(actor, JSON.parse(raw))); }
    catch (error) { reply(error.status ?? 500, { error: error.message }); }
  });
  return { server, bodies, anchorMerge };
}
