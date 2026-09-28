import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { navigationScope } from '../dist/context/navigation.js';
import { computeImpact } from '../dist/graph/impact.js';
const index = {
    version: 1, repo: 'fixture/billing', branch: 'main', files_indexed: 2,
    routes: [{ method: 'POST', path: '/billing/charge', file: 'src/billing.ts', line: 3, framework: 'express' }],
    modules: [
        { id: 'src/billing.ts', imports: [], exports: ['chargeCustomer'], symbols: [{ name: 'chargeCustomer', line: 1, calls: [] }], loc: 4, degree: 1 },
        { id: 'src/api.ts', imports: ['src/billing.ts'], exports: ['invoice'], symbols: [{ name: 'invoice', line: 2, calls: ['src/billing.ts::chargeCustomer'] }], loc: 4, degree: 1 },
    ], god_nodes: [], domains: [{ name: 'src', files: 2, loc: 8 }],
};
// Graph context only: memory is selected by the learning engine and measured by its own tests.
const cases = [
    { name: 'symbol', prompt: 'fix rounding in chargeCustomer' },
    { name: 'cited-file', prompt: 'inspect src/billing.ts' },
    { name: 'caller', prompt: 'change what invoice returns' },
    { name: 'off-topic', prompt: 'write the release notes' },
];
const results = cases.map(c => {
    const result = navigationScope(index, c.prompt);
    const latencies = [];
    for (let i = 0; i < 30; i++) {
        const start = performance.now();
        navigationScope(index, c.prompt);
        latencies.push(performance.now() - start);
    }
    latencies.sort((a, b) => a - b);
    return { name: c.name, result, characters: result.lines.join('\n').length, p50_ms: latencies[15], p95_ms: latencies[28] };
});
assert.deepEqual(results.find(r => r.name === 'off-topic').result.lines, [], 'no graph context for an unrelated prompt');
assert(results.find(r => r.name === 'symbol').result.files.includes('src/billing.ts'));
const impact = computeImpact(index, { id: 'src/billing.ts', kind: 'file' });
assert.equal(impact.direct, 1);
const report = {
    kind: 'local-regression-baseline', version: 3,
    limits: 'Synthetic fixtures; warm retrieval timings; characters are not tokens. No agent quality, token savings or provider costs measured.',
    results, impact,
};
if (process.argv.includes('--verify-baseline')) {
    const expected = JSON.parse(readFileSync(new URL('../tests/fixtures/context-v3.json', import.meta.url), 'utf8'));
    assert.deepEqual({ results: results.map(({ name, result }) => ({ name, result })), impact }, expected);
}
if (process.argv.includes('--write-baseline'))
    writeFileSync(new URL('../tests/fixtures/context-v3.json', import.meta.url), JSON.stringify({ results: results.map(({ name, result }) => ({ name, result })), impact }, null, 2) + '\n');
const output = process.argv.indexOf('--output');
if (output >= 0 && process.argv[output + 1])
    writeFileSync(process.argv[output + 1], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length, checks: 'passed', metrics: results.map(({ name, characters, p50_ms, p95_ms }) => ({ name, characters, p50_ms, p95_ms })) }, null, 2));
