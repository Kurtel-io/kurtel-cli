import { createServer } from 'node:http';

// Public transport fixture only. Authorization/storage policy is tested in the private engine.
export function teamFixture() {
  let record = null, sequence = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const actor = req.headers.authorization?.includes('alice-') ? 'alice' : 'bob';
    let result;
    if (body.action === 'identity') result = { actor, expires_at: '2030-01-01T00:00:00Z', grants: [{ team: 'alpha', repo: 'org/repo', role: 'member' }] };
    else if (body.action === 'publish') {
      const p = body.publication; sequence++;
      record = { id: p.id, version: sequence, team: body.team, repo: body.repo, kind: p.kind, author: actor, promoted_by: actor, promoter_role: 'member', expires_at: '2030-01-01T00:00:00Z', batch: { events: [{ kind: 'acceptance', content: p.reason, actor }], sources: p.evidence.map(e => ({ ...e, content: e.summary })), versions: [{ id: 'team:v1', content: p.content, zones: p.files }] } }; result = { record };
    } else if (body.action === 'erase') { record = null; sequence++; result = { updates: [], cursor: sequence, more: false }; }
    else if (body.action === 'context') result = { revision: String(sequence), records: record && body.paths.includes('src/payment.ts') ? [record] : [] };
    else if (body.action === 'history') result = { records: record ? [record] : [] };
    else result = { updates: record ? [{ record, sequence }] : [], cursor: sequence, more: false };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocol: 2, ...result }));
  });
  return { server, requests };
}
