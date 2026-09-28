import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const base = mkdtempSync(join(tmpdir(), 'kurtel-web-login-')), home = join(base, 'home'), root = join(base, 'repo'); mkdirSync(home); mkdirSync(root);
process.env.HOME = home; process.env.USERPROFILE = home;
const { saveSession, clearSession } = await import('../dist/lib/config.js');
const { connectWebTeam, bindTeam, teamWhoami, teamOperation } = await import('../dist/memory/team.js');
const { saveNetworkPolicy } = await import('../dist/security/network.js');
let currentToken = 'krtl_first-test-browser-credential', calls = 0;
const server = createServer(async (req, res) => {
  calls++;
  assert.equal(req.url, '/api/memory/team');
  if (req.headers.authorization !== `Bearer ${currentToken}`) { res.writeHead(401); res.end('{}'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body.action === 'identity' ? { protocol: 2, actor: 'web_user', expires_at: '2030-01-01T00:00:00Z', grants: [{ team: 'org', repo: 'org/repo', role: 'member' }] } : { protocol: 2, updates: [], cursor: 0, more: false }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`; process.env.KURTEL_API_URL = origin;
try {
  saveSession({ token: currentToken });
  assert.equal((await connectWebTeam()).actor, 'web_user');
  await bindTeam(root, 'org', 'org/repo');
  const saved = readFileSync(join(home, '.kurtel/team-session.json'), 'utf8');
  assert(!saved.includes(currentToken), 'Web token is not duplicated into team credentials');
  currentToken = 'krtl_rotated-test-browser-credential'; saveSession({ token: currentToken });
  assert.equal((await teamWhoami()).actor, 'web_user', 'Transport uses current login credential');
  await teamOperation(root, { action: 'sync' });
  const count = calls; saveNetworkPolicy({ version: 1, mode: 'private', engine_origins: [origin] });
  await assert.rejects(() => teamWhoami(), /blocks cloud/); assert.equal(calls, count, 'Allowlisted engine origin does not authorize cloud credential transport');
  saveNetworkPolicy({ version: 1, mode: 'cloud', engine_origins: [] });
  process.env.KURTEL_API_URL = 'https://other.invalid'; assert.equal(await teamWhoami(), null, 'Login cannot be reused on another API origin');
  process.env.KURTEL_API_URL = origin; clearSession(); assert.equal(await teamWhoami(), null);
  console.log('Web team login passed: existing credential reuse, no duplicate secret, fresh token, origin pinning, logout and private-policy denial.');
} finally { await new Promise(resolve => server.close(resolve)); }
