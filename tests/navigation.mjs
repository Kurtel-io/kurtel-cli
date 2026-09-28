import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { buildIndex } from '../dist/graph/indexer.js';
import { navigationContext } from '../dist/context/navigation.js';
import { contentFingerprint } from '../dist/runtime/reindex.js';

const base = resolve(tmpdir());
const root = mkdtempSync(join(base, 'kurtel-navigation-'));
try {
  mkdirSync(join(root, 'services'));
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config/base.json'), '{ // aliases are relative to this config\n"compilerOptions": {"baseUrl":"..","paths":{"@/*":["./*"],"payments":["missing","services/payments"]}},}');
  writeFileSync(join(root, 'tsconfig.json'), '{"extends":"./config/base"}');
  writeFileSync(join(root, 'services/payments.ts'), 'export function settlePayment() { return 1; }');
  writeFileSync(join(root, 'checkout.ts'), "import { settlePayment } from '@/services/payments';\nexport function checkout() { return settlePayment(); }");
  writeFileSync(join(root, 'scheduled.ts'), "import { settlePayment } from 'payments';\nexport function schedule() { return settlePayment(); }");
  const prefix = '/*' + 'padding '.repeat(140000) + '*/\n';
  const many = Array.from({length: 75}, (_, i) => `function filler${i}() { return ${i}; }`).join('\n');
  writeFileSync(join(root, 'worker.js'), `${prefix}${many}\nfunction inspectCacheDrift() { return 1; }\nfunction reconcileCache() { return inspectCacheDrift(); }\n`);
  const index = await buildIndex(root);
  assert.equal(index.parser.regex_fallbacks, 0);
  assert(index.modules.find(m => m.id === 'worker.js').symbols.some(s => s.name === 'inspectCacheDrift'), 'late non-exported definition in >1MB file');
  assert(index.modules.find(m => m.id === 'worker.js').symbols.some(s => s.calls.includes('worker.js::inspectCacheDrift')), 'late call edges retained');
  assert.deepEqual(index.modules.find(m => m.id === 'checkout.ts').imports, ['services/payments.ts']);
  assert.deepEqual(index.modules.find(m => m.id === 'scheduled.ts').imports, ['services/payments.ts']);
  const references = navigationContext(index, 'Which files import services/payments.ts?').join('\n');
  assert.match(references, /imported by: checkout.ts/);
  assert.match(references, /imported by: scheduled.ts/);
  const query = navigationContext(index, 'Investigate cache drift. Return files and a JSON explanation.').join('\n');
  assert.match(query, /inspectCacheDrift/);
  assert.match(query, /caller reconcileCache/);
  assert.deepEqual(navigationContext(index, 'Discuss lunar geology. Return files and functions.'), [], 'unrelated task must stay silent');
  const fp = contentFingerprint(root);
  writeFileSync(join(root, 'config/base.json'), '{"compilerOptions":{"paths":{"@/*":["../missing/*"]}}}');
  assert.notEqual(contentFingerprint(root), fp, 'inherited alias edits invalidate freshness');
  const rebuilt = await buildIndex(root);
  assert.deepEqual(rebuilt.modules.find(m => m.id === 'checkout.ts').imports, []);
  console.log('PASS: >1MB code, late symbols/calls, JSONC inherited/exact/wildcard aliases, dependency context, abstention and config freshness.');
} finally {
  assert.equal(dirname(root), base);
  rmSync(root, {recursive:true, force:true});
}
