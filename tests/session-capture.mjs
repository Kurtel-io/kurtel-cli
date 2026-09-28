// Memory mechanics in throwaway repositories: activation by project markers, not by kurtel.io access.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fixture = mkdtempSync(join(tmpdir(), 'kurtel-capture-'));
const root = join(fixture, 'repo'), home = join(fixture, 'home');
mkdirSync(root); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const { captureHook, captureEnabled, setCaptureEnabled, readSession, ingestSession, sessionsPath, listSessions } = await import('../dist/integrations/claude-code/capture.js');
const { activateRepo, setMemoryEnabled } = await import('../dist/storage/state.js');
const { readKnowledge, knowledgePath } = await import('../dist/storage/knowledge.js');
const { setConfigValue } = await import('../dist/lib/config.js');
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: process.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
const input = { session_id: 'session-1', cwd: root, prompt_id: 'turn-1', prompt: 'Utilise notre passerelle interne car le client interdit les appels externes.' };
assert.equal(captureEnabled(root), false);
captureHook(root, 'user-prompt-submit', input);
assert.equal(existsSync(sessionsPath(root)), false);
assert.throws(() => setCaptureEnabled(root, true), /Activate/);
activateRepo(root);
captureHook(root, 'user-prompt-submit', input);
assert.equal(existsSync(sessionsPath(root)), false, 'onboarding alone does not enable conversation capture');
setCaptureEnabled(root, true);
for (let i = 0; i < 2; i++) {
  const hook = run(['hook', 'user-prompt-submit'], input);
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, '');
}
assert.equal(readSession(root, 'session-1').length, 1, 'provider IDs deduplicate retries');
captureHook(root, 'user-prompt-submit', { ...input, prompt_id: 'turn-2', prompt: 'oui' });
captureHook(root, 'user-prompt-submit', { ...input, prompt_id: undefined, prompt: 'encore' });
captureHook(root, 'user-prompt-submit', { ...input, prompt_id: undefined, prompt: 'encore' });
assert.equal(readSession(root, 'session-1').length, 4, 'identical real messages without IDs are not silently lost');
const tool = { session_id: 'session-1', cwd: root, tool_use_id: 'tool-1', tool_name: 'Bash', tool_input: { command: 'npm test' } };
for (const event of ['pre-tool-use', 'post-tool-use-failure']) {
  const hook = run(['hook', event], { ...tool, error: 'Tests failed' });
  assert.equal(hook.status, 0); assert.equal(hook.stdout, '');
}
captureHook(root, 'post-tool-use', { ...tool, tool_use_id: 'tool-2', tool_response: { stdout: 'Tests passed', exitCode: 0 } });
captureHook(root, 'post-tool-use', { ...tool, tool_use_id: 'read-1', tool_name: 'Read', tool_input: { file_path: '.env' }, tool_response: 'SECRET_CONTENT_NOT_TO_COPY' });
const stop = run(['hook', 'stop'], { ...input, last_assistant_message: 'Je propose de remplacer la passerelle. Tout est terminé.', transcript_path: join(fixture, 'not-read.jsonl') });
assert.equal(stop.status, 0); assert.equal(stop.stdout, '');
let store = readKnowledge(root);
assert.equal(store.versions.length, 0, 'capture does not invent accepted durable knowledge');
assert(store.events.some(e => e.kind === 'instruction' && e.content === 'oui'));
assert(store.events.some(e => e.kind === 'proposal'));
assert(store.events.some(e => e.kind === 'action_attempted'));
assert(!store.events.some(e => ['acceptance', 'outcome_verified'].includes(e.kind)));
assert(!JSON.stringify(store).includes('SECRET_CONTENT_NOT_TO_COPY'));
assert.equal(ingestSession(root, 'session-1'), 0);
const revision = store.revision;
assert.equal(ingestSession(root, 'session-1'), 0);
assert.equal(readKnowledge(root).revision, revision);

// A locked knowledge store cannot lose the already captured turn.
writeFileSync(knowledgePath(root) + '.lock', 'active-writer');
assert.equal(run(['hook', 'stop'], { ...input, prompt_id: 'turn-locked', last_assistant_message: 'Réponse conservée malgré le verrou.' }).status, 0);
assert.equal(readKnowledge(root).revision, revision);
unlinkSync(knowledgePath(root) + '.lock');
assert.equal(ingestSession(root, 'session-1'), 1);

const beforeParallel = readSession(root, 'session-1').length;
await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, 'hook', 'pre-tool-use'], { cwd: root, env: process.env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`hook exited ${code}`)));
  child.stdin.end(JSON.stringify({ ...tool, tool_use_id: 'parallel-same-call' }));
})));
assert.equal(readSession(root, 'session-1').length, beforeParallel + 1, 'concurrent duplicate delivery publishes exactly one complete record');
const oversized = run(['hook', 'user-prompt-submit'], { ...input, prompt_id: 'oversized', prompt: 'x'.repeat(2 * 1024 * 1024) });
assert.equal(oversized.status, 0);
assert.equal(readSession(root, 'session-1').length, beforeParallel + 1);

const count = readSession(root, 'session-1').length;
setMemoryEnabled(root, false);
captureHook(root, 'user-prompt-submit', { ...input, prompt_id: 'off-1' });
assert.equal(readSession(root, 'session-1').length, count);
setMemoryEnabled(root, true);
setConfigValue('memoryDisabled', true);
captureHook(root, 'user-prompt-submit', { ...input, prompt_id: 'off-global' });
assert.equal(readSession(root, 'session-1').length, count);
setConfigValue('memoryDisabled', false);
setCaptureEnabled(root, false);
captureHook(root, 'user-prompt-submit', { ...input, prompt_id: 'off-capture' });
assert.equal(readSession(root, 'session-1').length, count);
setCaptureEnabled(root, true);
captureHook(root, 'user-prompt-submit', { ...input, session_id: '../../escaped', prompt: 'password=secret123 api_key=abc123 Bearer abc.def.ghi ' + 'x'.repeat(13000) });
const secret = readSession(root, '../../escaped')[0];
assert(!JSON.stringify(secret).includes('secret123'));
assert(!JSON.stringify(secret).includes('abc123'));
assert(!JSON.stringify(secret).includes('abc.def.ghi'));
assert.equal(JSON.parse(secret.source.content).truncated, true);
assert.equal(JSON.parse(secret.source.content).redacted, true);
assert.equal(existsSync(join(fixture, 'escaped')), false);
assert.equal(listSessions(root).length, 2);
assert.equal(run(['sessions', 'list']).status, 0);
assert.equal(JSON.parse(run(['sessions', 'show', 'session-1']).stdout).length, count);
assert.equal(JSON.parse(run(['sessions', 'status']).stdout).active, true);
assert.equal(run(['hook', 'stop'], { ...input, last_assistant_message: undefined }).status, 0);

// Installer preserves foreign hooks and wires all events exactly once on repeated upgrades.
mkdirSync(join(root, '.claude'), { recursive: true });
writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo external' }] }] } }));
for (let i = 0; i < 2; i++) assert.equal(run(['install', 'claude-code', '--force']).status, 0);
const hooks = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'))).hooks;
for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) assert.equal(hooks[event].flatMap(m => m.hooks).filter(h => h.command.startsWith('kurtel hook')).length, 1);
assert(hooks.Stop.flatMap(m => m.hooks).some(h => h.command === 'echo external'));
assert.equal(run(['uninstall', 'claude-code']).status, 0);
assert.equal(JSON.parse(readFileSync(join(root, '.claude', 'settings.json'))).hooks.Stop[0].hooks[0].command, 'echo external');
console.log('PASS: local session capture, opt-in/kill switches, retry identity, proposals vs acceptance, tool outcomes, lock recovery, redaction, CLI and hook installation.');
