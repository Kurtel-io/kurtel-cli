// Visibility across branches, on real Git clones: knowledge reaches a checkout only once its code does.
process.env.KURTEL_ACTIVATION ??= "markers";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const { createEngineServer } = await import('./fixtures/lesson-engine.mjs');
const { createSharedServer } = await import('./fixtures/shared-server.mjs');

const temp = mkdtempSync(join(tmpdir(), 'kurtel-branches-'));
const home = join(temp, 'home'); mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
const env = { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const origin = join(temp, 'origin.git');
git(temp, 'init', '-q', '--bare', '-b', 'main', origin);
const url = `file:///${origin.replace(/\\/g, '/')}`;
const seed = join(temp, 'seed');
git(temp, 'clone', '-q', url, seed);
mkdirSync(join(seed, 'src')); writeFileSync(join(seed, 'src', 'pay.ts'), 'export const total = 1;\n'); writeFileSync(join(seed, 'src', 'tax.ts'), 'export const tax = 1;\n');
git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', 'origin', 'main');
const [alice, bob, github] = ['alice', 'bob', 'github'].map(name => { const dir = join(temp, name); git(temp, 'clone', '-q', url, dir); return dir; });

const { captureHook, setCaptureEnabled } = await import('../dist/integrations/session-capture.js');
const { activateRepo } = await import('../dist/storage/state.js');
const { learnSession, configureLearning } = await import('../dist/memory/session-learning.js');
const { compactContext } = await import('../dist/context/compact.js');
const shared = await import('../dist/memory/shared.js');
const { anchorKnowledge } = await import('../dist/memory/visibility.js');
const { startCorrectionCheck } = await import('../dist/memory/automatic.js');
const { knowledgePath } = await import('../dist/storage/knowledge.js');
const { sessionKey } = await import('../dist/storage/usage.js');
const { repoSlug } = await import('../dist/repository/git.js');

const token = 'branch-visibility-token-0000000000000000000';
process.env.KURTEL_ENGINE_TOKEN = token;
const engine = createEngineServer({ token, model: async (_i, input) => 'quote' in input ? { keep: true } : ({ working: [], candidates: input.events.filter(e => e.content.startsWith('DECISION:')).map(e => ({ event_id: e.id, quote: e.content, kind: 'decision', zones: [...new Set(e.content.match(/src\/[\w.]+/g) ?? [])], reason_event_id: null, reason_quote: null })) }), correctionModel: async (_i, input) => 'rules' in input ? { correction: false, contradicted: [], explanation: null } : { remember: null } });
await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
const { server, anchorMerge } = await createSharedServer({ tokens: { 'token-alice-000000000000000000000000': 'alice', 'token-bob-000000000000000000000000': 'bob' } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.argv[1] = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const as = dev => { process.env.KURTEL_SHARED_TOKEN = `token-${dev}-000000000000000000000000`; return dev === 'alice' ? alice : bob; };
for (const [dev, root] of [['alice', alice], ['bob', bob]]) {
  as(dev); activateRepo(root); setCaptureEnabled(root, true);
  configureLearning(root, `http://127.0.0.1:${engine.address().port}/v1/extract`);
  shared.enableSharing(root, `http://127.0.0.1:${server.address().port}/api/memory/knowledge`);
}
assert.equal(repoSlug(alice), repoSlug(bob), 'same repository on the server');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let tick = 0;
async function learn(root, session, file, rule) {
  const capture = async (hook, input) => { await sleep(5); captureHook(root, hook, { session_id: session, prompt_id: `p-${tick}`, tool_use_id: `t-${tick++}`, ...input }); };
  await capture('user-prompt-submit', { prompt: `Rework ${file}` });
  writeFileSync(join(root, file), `// reworked ${tick}\n`);
  await capture('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file } });
  await capture('stop', { last_assistant_message: rule });
  await learnSession(root, session);
  // A next message that is not a correction validates the turn.
  await capture('user-prompt-submit', { prompt: 'Looks good, thanks.' });
  startCorrectionCheck(root, session);
  const pending = join(dirname(knowledgePath(root)), 'context', `pending-${sessionKey(session)}.json`);
  for (let i = 0; i < 400 && existsSync(pending); i++) await sleep(25);
  await sleep(300);
}
const commit = async (root, message) => { await sleep(1100); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', message); return git(root, 'rev-parse', 'HEAD'); };
const sees = async (root, file, text) => (await compactContext(root, null, `change ${file}`, { paths: [file] })).items.some(i => i.text.includes(text));

// 1. Learned on a branch, not committed yet: nothing to anchor.
as('alice');
git(alice, 'checkout', '-q', '-b', 'refacto');
const K1 = 'DECISION: src/pay.ts now returns cents from total()';
await learn(alice, 'a1', 'src/pay.ts', K1);
assert.equal(anchorKnowledge(alice), 0, 'uncommitted: not anchored');
assert(await sees(alice, 'src/pay.ts', 'returns cents'), 'visible on its own branch');
// Committed: anchored and shared.
const aliceCommit = await commit(alice, 'refacto: cents');
assert.equal(anchorKnowledge(alice), 1);
await shared.syncShared(alice);
git(alice, 'push', '-q', 'origin', 'refacto');
// On main, the author does not see it either.
git(alice, 'checkout', '-q', 'main');
assert(!(await sees(alice, 'src/pay.ts', 'returns cents')), 'hidden for its author on another branch');
git(alice, 'checkout', '-q', 'refacto');

// 2. A teammate on main receives it but does not see it.
as('bob');
await shared.syncShared(bob);
assert(!(await sees(bob, 'src/pay.ts', 'returns cents')), 'hidden: code not here');
git(bob, 'fetch', '-q', 'origin');
assert(!(await sees(bob, 'src/pay.ts', 'returns cents')), 'fetched but not merged: still hidden');
git(bob, 'merge', '-q', '--no-edit', 'origin/refacto');
assert.equal(git(bob, 'merge-base', '--is-ancestor', aliceCommit, 'HEAD') === '', true);
assert(await sees(bob, 'src/pay.ts', 'returns cents'), 'visible once merged');

// 3. Squash merge: anchored on the merge commit.
as('alice');
git(alice, 'checkout', '-q', 'main'); git(alice, 'pull', '-q', 'origin', 'main'); git(alice, 'checkout', '-q', '-b', 'taxes');
const K2 = 'DECISION: src/tax.ts rounds VAT per line';
await learn(alice, 'a2', 'src/tax.ts', K2);
await commit(alice, 'taxes'); anchorKnowledge(alice); await shared.syncShared(alice);
git(alice, 'push', '-q', 'origin', 'taxes');
git(github, 'fetch', '-q', 'origin'); git(github, 'merge', '-q', '--squash', 'origin/taxes');
const squash = await commit(github, 'Taxes (#7)'); git(github, 'push', '-q', 'origin', 'main');
as('bob');
git(bob, 'pull', '-q', '--no-edit', 'origin', 'main');
await shared.syncShared(bob);
assert(!(await sees(bob, 'src/tax.ts', 'rounds VAT')), "squashed: Alice's commit is not in Bob's history");
assert.equal(await anchorMerge({ repo: repoSlug(bob), branch: 'taxes', commit: squash, mergedAt: new Date().toISOString(), pullRequest: 7 }), 1);
await shared.syncShared(bob);
assert(await sees(bob, 'src/tax.ts', 'rounds VAT'), 'visible after the merge anchor');

// 4. A branch never merged stays on its branch.
as('alice');
const K3 = 'DECISION: src/pay.ts drops the legacy total';
await learn(alice, 'a3', 'src/pay.ts', K3);
await commit(alice, 'experiment'); anchorKnowledge(alice); await shared.syncShared(alice);
as('bob');
await shared.syncShared(bob);
assert(!(await sees(bob, 'src/pay.ts', 'drops the legacy')), 'abandoned branch: never visible elsewhere');

await new Promise(resolve => server.close(resolve));
await new Promise(resolve => engine.close(resolve));
console.log(`PASS: branch visibility (${process.env.KURTEL_TEST_SHARED ? 'private server' : 'protocol fixture'}) — anchored only once committed, visible on its branch, hidden for its author elsewhere, hidden after fetch, visible after merge, squash merge anchored by the merge webhook, abandoned branch never visible.`);
