import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const base = resolve(tmpdir());
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const fixture = mkdtempSync(join(base, 'cli-check-'));
const home = join(fixture, 'home'), repo = join(fixture, 'repo');
mkdirSync(home);
mkdirSync(repo);
process.env.USERPROFILE = home;
process.env.HOME = home;
const cli = join(packageRoot, 'dist/index.js');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig') };
let result = spawnSync('git', ['init', repo], { env, encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 0, result.stderr);
function run(args, input) { return spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, input, encoding: 'utf8', timeout: 15000, windowsHide: true }); }
result = run(['--help']);
assert.equal(result.status, 0);
assert.match(result.stdout, /impact/);
assert.match(result.stdout, /memory/);
for (const cmd of ['run', 'runs', 'agents', 'logs', 'status', 'stop']) {
    const r = run([cmd]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown command/);
    assert.equal(existsSync(join(packageRoot, 'dist', 'commands', cmd + '.js')), false);
}
result = run(['hook', 'session-start'], '{}');
assert.equal(result.status, 0);
assert.equal(existsSync(join(repo, '.kurtel')), false);
const dir = join(repo, '.claude', 'commands', 'kurtel');
mkdirSync(dir, { recursive: true });
for (const name of ['run', 'runs', 'agents', 'logs', 'run-status', 'stop'])
    writeFileSync(join(dir, name + '.md'), 'legacy');
writeFileSync(join(dir, 'custom.md'), 'keep me');
const settings = join(repo, '.claude', 'settings.json');
writeFileSync(settings, JSON.stringify({ customSetting: true, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo external' }] }] } }));
// Retired commit learning: the post-commit block of older versions is removed, third-party hooks kept.
const postCommit = join(repo, '.git', 'hooks', 'post-commit');
const legacyBlock = '# >>> kurtel auto-learn (do not edit) >>>\ncommand -v kurtel >/dev/null 2>&1 && (kurtel learn-commit >/dev/null 2>&1 &)\n# <<< kurtel auto-learn <<<\n';
writeFileSync(postCommit, '#!/bin/sh\necho third-party\n\n' + legacyBlock);
for (let i = 0; i < 2; i++) {
    result = run(['install', 'claude-code']);
    assert.equal(result.status, 0, result.stderr);
}
assert.equal(readFileSync(postCommit, 'utf8').includes('kurtel'), false, 'legacy commit-learning block removed');
assert.match(readFileSync(postCommit, 'utf8'), /echo third-party/);
writeFileSync(postCommit, '#!/bin/sh\n' + legacyBlock);
assert.equal(run(['learn-commit']).status, 0);
assert.equal(existsSync(postCommit), false, 'an old hook calling learn-commit removes itself');
for (const name of ['run', 'runs', 'agents', 'logs', 'run-status', 'stop'])
    assert.equal(existsSync(join(dir, name + '.md')), false);
for (const name of ['onboard', 'status', 'memory', 'impact', 'custom'])
    assert.equal(existsSync(join(dir, name + '.md')), true);
const configured = JSON.parse(readFileSync(settings));
assert.equal(configured.customSetting, true);
const hooks = configured.hooks.SessionStart.flatMap(m => m.hooks);
assert.equal(hooks.filter(h => h.command === 'kurtel hook session-start').length, 1);
assert(hooks.some(h => h.command === 'echo external'));
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src', 'billing.ts'), 'export function chargeCustomer() { return 1; }\n');
writeFileSync(join(repo, 'src', 'api.ts'), "import { chargeCustomer } from './billing';\nexport function invoice() { return chargeCustomer(); }\n");
const { buildIndex } = await import(pathToFileURL(join(packageRoot, 'dist/graph/indexer.js')));
const { computeImpact } = await import(pathToFileURL(join(packageRoot, 'dist/graph/impact.js')));
const index = await buildIndex(repo);
assert.equal(index.files_indexed, 2);
assert(index.modules.find(m => m.id === 'src/api.ts').imports.includes('src/billing.ts'));
assert.equal(computeImpact(index, { id: 'src/billing.ts', kind: 'file' }).direct, 1);
result = run(['uninstall', 'claude-code']);
assert.equal(result.status, 0, result.stderr);
assert(JSON.parse(readFileSync(settings)).hooks.SessionStart.some(m => m.hooks.some(h => h.command === 'echo external')));
const baseline = spawnSync(process.execPath, [join(packageRoot, 'scripts/benchmark.mjs'), '--verify-baseline'], {
    cwd: repo, env, encoding: 'utf8', timeout: 15000, windowsHide: true,
});
assert.equal(baseline.status, 0, baseline.stderr);
console.log('PASS: retired commands rejected; inactive hook silent; integration upgrade idempotent; custom commands/hooks preserved; legacy commit hook removed; index/import/impact work.');
// Delete only the unique temporary fixture created by this process.
assert.equal(dirname(fixture), base);
rmSync(fixture, { recursive: true, force: true });
