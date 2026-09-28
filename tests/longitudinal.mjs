import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tasks } from '../eval/longitudinal/tasks.mjs';
import { applySolution, solutions } from '../eval/longitudinal/solutions.mjs';
import { checkTask, correctionMessage, conventions } from '../eval/longitudinal/checks.mjs';
import { acceptanceDir, loadFixture, materialize, overlay, validateSuite } from '../eval/longitudinal/preflight.mjs';
import { analyzeSession, summarize } from '../eval/longitudinal/analysis.mjs';

const work = mkdtempSync(join(tmpdir(), 'kurtel-longitudinal-'));
try {
  assert.equal(new Set(tasks.map(t => t.id)).size, tasks.length);
  assert(tasks.filter(t => t.split === 'dev').length >= 14 && tasks.filter(t => t.split === 'reserve').length >= 6);
  for (const task of tasks) assert(!/centimes|clock|AppError|emit\(|validate\(|logger|repositor|i18n|legacy/i.test(task.prompt), `${task.id} prompt leaks a convention`);

  const suite = validateSuite(tasks, work);
  assert(suite.tasks.every(t => t.base_fails && t.reference_passes));
  assert(Object.values(suite.conventions).every(Boolean));

  // Typical convention breaches in otherwise working code must reach the reviewer with the right wording.
  const fixture = loadFixture(), root = join(work, 'comptoir');
  const trap = (taskId, from, to) => {
    const task = tasks.find(t => t.id === taskId);
    const files = applySolution(fixture, solutions[taskId]);
    const [file] = [...files].find(([, text]) => text.includes(from)) ?? [];
    assert(file, `anchor ${from} not found for ${taskId}`);
    files.set(file, files.get(file).replace(from, to));
    materialize(root, fixture); overlay(root, fixture, files);
    const check = checkTask(root, task, acceptanceDir);
    return { check, message: correctionMessage(check) };
  };
  let result = trap('t01-refund', "refunded_at: now().toISOString()", "refunded_at: new Date().toISOString()");
  assert(!result.check.passed && result.message.conventions.includes('C2') && result.message.text.includes(conventions.C2.correction));
  assert(result.check.acceptance.failures.some(f => f.convention === 'C2'), 'behavioral clock check');
  result = trap('t02-loyalty', 'percentOf(subtotal_cents, LOYALTY_PERCENT)', 'Math.round(subtotal_cents * LOYALTY_PERCENT / 100)');
  assert(!result.check.passed && result.message.conventions.includes('C1'));
  result = trap('t03-email-route', "    validate({ email: 'email' }, body);\n", '');
  assert(!result.check.passed && result.message.conventions.includes('C9'));
  result = trap('t09-cancel', "  emit('order.cancelled', { order_id: orderId });\n", '');
  assert(!result.check.passed && result.message.conventions.includes('C8'));
  result = trap('t01-refund', "throw new AppError('ORDER_NOT_PAID', { id: orderId })", "throw new Error('ORDER_NOT_PAID')");
  assert(!result.check.passed && result.message.conventions.includes('C6'));
  // A missing feature is a specification failure, never blamed on a convention.
  materialize(root, fixture);
  const missing = correctionMessage(checkTask(root, tasks[0], acceptanceDir));
  assert.deepEqual(missing.conventions, []);
  assert.match(missing.text, /tests de recette/);

  // Timeline analysis: injections before/after the first edit, usage, rework after a correction, cost and tokens.
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'system', subtype: 'hook_response', hook_event: 'UserPromptSubmit', stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'Memory version:1 [action; constraint]: see src/lib/clock.js' } }) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${root}/src/lib/clock.js` } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${root}\\src\\services\\orders.js` } }] } },
    { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'Memory version:2 [action]: src/lib/log.js' } }) },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'node --test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: '# pass 3\n# fail 1' }] } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.1, duration_ms: 1000, num_turns: 3, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 } },
    { type: 'harness_correction', conventions: ['C2'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: `${root}/src/services/orders.js` } }] } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.15, duration_ms: 500, num_turns: 1, usage: { input_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 4 } },
  ];
  const analysis = analyzeSession(events, root, text => text.length);
  assert.equal(analysis.session_id, 's1');
  assert.equal(analysis.cost_usd, 0.15);
  assert.equal(analysis.usage.total, 190);
  assert.equal(analysis.model_ms, 1500);
  assert.deepEqual([analysis.tools.Read, analysis.tools.Edit, analysis.tools.Bash], [1, 2, 1]);
  assert.equal(analysis.rework_edits, 1);
  assert.equal(analysis.failed_test_runs, 1);
  assert.deepEqual(analysis.injections.map(i => [i.before_first_edit, i.used_files.length, i.memory_ids.length]), [[true, 1, 1], [false, 0, 1]]);
  assert.equal(analysis.injection_summary.memory_before_first_edit, 1);
  const [summary] = summarize([{ condition: 'full', task: 't', order: 0, success: true, corrections: 1, correction_conventions: ['C2'], agent_ms: 10, cost_usd: 0.15, learning: { cost_usd: 0.05 }, ...analysis }]);
  assert.equal(summary.cost_per_success_usd, 0.2);
  assert.deepEqual(summary.corrections_by_convention, { C2: 1 });
  assert.equal(summary.injection_usage_rate, 0.5);
  // Pre-edit gate: the held edit never ran, its rules count as delivered before the first real edit.
  const held = analyzeSession([
    { type: 'system', subtype: 'init', session_id: 's2' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h1', name: 'Edit', input: { file_path: `${root}/src/services/orders.js` } }] } },
    { type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Kurtel — sourced rules for src/services/orders.js, shown once:\n- constraint: Use now() from src/lib/clock.js.\n  Applies to src. Source: s (review). Memory v-7.' } }) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'h1', is_error: true, content: 'Kurtel — sourced rules for src/services/orders.js, shown once' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h2', name: 'Edit', input: { file_path: `${root}/src/services/orders.js` } }] } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.1, duration_ms: 1, num_turns: 2, usage: {} },
  ], root, text => text.length);
  assert.equal(held.held_edits, 1); assert.equal(held.tools.Edit, 1);
  assert.deepEqual(held.injections.map(i => [i.event, i.before_first_edit, i.memory_ids]), [['PreToolUse', true, ['v-7']]]);
  console.log('PASS: longitudinal suite discriminates every task, reviewer detects each convention and trap, timeline metrics and summaries.');
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
