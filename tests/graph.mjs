import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractFileAst } from '../dist/graph/parser.js';
import { buildIndex } from '../dist/graph/indexer.js';
import { contentFingerprint } from '../dist/runtime/reindex.js';

const samples = [
  ['ts', 'export function hello() { return 1; }'],
  ['mts', 'export function hello() { return 1; }'],
  ['cts', 'export function hello() { return 1; }'],
  ['tsx', 'export function hello() { return <div />; }'],
  ['js', 'export function hello() { return 1; }'],
  ['py', 'def hello():\n    return 1\n'],
  ['java', 'class Example { public int hello() { return 1; } }'],
  ['go', 'package main\nfunc hello() int { return 1 }'],
  ['rs', 'pub fn hello() -> i32 { 1 }'],
  ['cs', 'class Example { public int hello() { return 1; } }'],
];
for (const [ext, source] of samples) {
  const facts = await extractFileAst(`example.${ext}`, source, `.${ext}`);
  assert(facts, `${ext}: AST must load without regex fallback`);
  assert(facts.defs.some(d => d.name === 'hello'), `${ext}: missing function`);
}
const base = resolve(tmpdir());
const root = mkdtempSync(join(base, 'kurtel-graph-'));
function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}
try {
  git('init');
  const file = join(root, 'service.mts');
  writeFileSync(file, 'export function first() { return 1; }');
  writeFileSync(join(root, 'api.ts'), "import { first } from './service.mjs';\nexport function api() { return first(); }");
  let index = await buildIndex(root);
  assert.equal(index.parser.regex_fallbacks, 0);
  assert(index.modules.find(m => m.id === 'api.ts').imports.includes('service.mts'));
  assert(index.modules.find(m => m.id === 'api.ts').symbols.some(s => s.calls.includes('service.mts::first')));
  assert.deepEqual(await buildIndex(root), index);
  const before = contentFingerprint(root);
  const time = statSync(file);
  writeFileSync(file, 'export function other() { return 2; }');
  utimesSync(file, time.atime, time.mtime);
  assert.notEqual(contentFingerprint(root), before, 'timestamp-preserving edits');
  index = await buildIndex(root);
  assert(index.modules.find(m => m.id === 'service.mts').symbols.some(s => s.name === 'other'));
  renameSync(file, join(root, 'renamed.mts'));
  index = await buildIndex(root);
  assert(!index.modules.some(m => m.id === 'service.mts'));
  assert.deepEqual(index.modules.find(m => m.id === 'api.ts').imports, []);
  rmSync(join(root, 'renamed.mts'));
  assert.equal((await buildIndex(root)).files_indexed, 1);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const branchFp = contentFingerprint(root);
  git('checkout', '-b', 'same-files');
  assert.notEqual(contentFingerprint(root), branchFp, 'branch change without file changes');
  assert.equal((await buildIndex(root)).branch, 'same-files');
  // Git-ignored copies and generated files are not project code; untracked, non-ignored files still are.
  mkdirSync(join(root, 'results', 'copy'), { recursive: true });
  writeFileSync(join(root, 'results', 'copy', 'api.ts'), 'export function api() { return 0; }');
  writeFileSync(join(root, 'generated.ts'), 'export const generated = 1;');
  writeFileSync(join(root, 'draft.ts'), 'export const draft = 1;');
  writeFileSync(join(root, '.gitignore'), 'results/\ngenerated.ts\n');
  const ids = (await buildIndex(root)).modules.map(m => m.id);
  assert(ids.includes('draft.ts') && !ids.includes('generated.ts') && !ids.some(id => id.startsWith('results/')), ids.join(', '));
  console.log('PASS: ten grammar variants; AST imports/calls; deterministic graph; edits, rename, deletion, branch freshness and Git-ignored paths.');
} finally {
  assert.equal(dirname(root), base);
  rmSync(root, { recursive: true, force: true });
}
