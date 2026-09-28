// Memory per organization plan, kurtel memory on|off and kurtel on|off, from a kept access answer.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'kurtel-plan-home-'));
process.env.HOME = home; process.env.USERPROFILE = home;
delete process.env.KURTEL_ACTIVATION; delete process.env.KURTEL_POLICY_FILE; delete process.env.KURTEL_ENGINE_TOKEN;
process.env.KURTEL_API_URL = 'https://app.example.test';
mkdirSync(join(home, '.kurtel'), { recursive: true });
writeFileSync(join(home, '.kurtel', 'config.json'), JSON.stringify({ token: 'cli-token-000000000000000000000000' }));

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kurtel-plan-repo-')));
execFileSync('git', ['init', '-q'], { cwd: root });
execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: root });

const { accessGated, accessMemory, withholdMemory } = await import('../dist/storage/access.js');
const { kurtelEnabled, memoryEnabled, repoActivated, setKurtelEnabled, setMemoryEnabled } = await import('../dist/storage/state.js');
const { engineTarget } = await import('../dist/memory/engine.js');
const { captureEnabled } = await import('../dist/integrations/session-capture.js');

const key = process.platform === 'win32' ? root.toLowerCase() : root;
const organization = { id: '11111111-1111-1111-1111-111111111111', slug: 'acme', name: 'Acme' };
const keep = memory => writeFileSync(join(home, '.kurtel', 'access.json'), JSON.stringify({ version: 1, entries: { [key]: { remote: 'github.com/acme/shop', active: true, checked_at: new Date().toISOString(), organization, repository_id: '22222222-2222-2222-2222-222222222222', role: 'member', ...(memory === undefined ? {} : { memory }) } } }));

assert.equal(accessGated(), true, 'activation follows kurtel.io');

// 1. Plan without memory: graph only.
keep(false);
assert.equal(repoActivated(root), true);
assert.equal(kurtelEnabled(root), true, 'graph on');
assert.equal(memoryEnabled(root), false, 'memory not included');
assert.equal(engineTarget(root, 'extract'), null, 'no engine without memory');
// An answer without the memory field: graph only.
keep(undefined);
assert.equal(memoryEnabled(root), false);

// 2. Plan with memory: the engine is kurtel.io, with the CLI token.
keep(true);
assert.equal(accessMemory(root), true);
assert.equal(memoryEnabled(root), true, 'memory included');
assert.equal(captureEnabled(root), true, 'capture automatic');
for (const op of ['extract', 'correction', 'context']) {
  const target = engineTarget(root, op);
  assert.equal(target.url.href, `https://app.example.test/api/memory/engine/${op}`);
  assert.equal(target.token, 'cli-token-000000000000000000000000');
  assert.equal(target.purpose, 'cloud');
  assert.deepEqual(target.where, { remote: 'github.com/acme/shop', organization: organization.id });
}
process.env.KURTEL_ENGINE_TOKEN = 'private-engine-secret-000000000000';
assert.equal(engineTarget(root, 'extract').token, 'cli-token-000000000000000000000000');
delete process.env.KURTEL_ENGINE_TOKEN;

// 3. kurtel memory off: graph only.
setMemoryEnabled(root, false);
assert.equal(kurtelEnabled(root), true);
assert.equal(memoryEnabled(root), false);
setMemoryEnabled(root, true);
assert.equal(memoryEnabled(root), true);

// 4. kurtel off: nothing.
setKurtelEnabled(root, false);
assert.equal(kurtelEnabled(root), false);
assert.equal(memoryEnabled(root), false);
setKurtelEnabled(root, true);
assert.equal(memoryEnabled(root), true);

// 5. memory_not_enabled from the server: graph only, access kept.
withholdMemory(root);
assert.equal(memoryEnabled(root), false);
assert.equal(repoActivated(root), true, 'access unchanged');
assert.equal(engineTarget(root, 'context'), null);

console.log('PASS: memory per organization plan — graph only without it (and for older answers), engine on kurtel.io with the CLI token when included, capture automatic, kurtel memory off keeps the graph, kurtel off stops everything, memory_not_enabled from the server turns memory off and keeps access.');
