import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTeamGuidance, removeTeamGuidance, TEAM_GUIDANCE } from '../dist/integrations/team-guidance.js';
const root = mkdtempSync(join(tmpdir(), 'kurtel-guidance-'));
try {
  const file = join(root, '.claude/rules/kurtel-team.md');
  installTeamGuidance(root); installTeamGuidance(root);
  assert.equal(readFileSync(file, 'utf8'), TEAM_GUIDANCE);
  removeTeamGuidance(root); assert.equal(existsSync(file), false);
  installTeamGuidance(root); writeFileSync(file, 'User guidance');
  assert.throws(() => installTeamGuidance(root), /left unchanged/);
  removeTeamGuidance(root); assert.equal(readFileSync(file, 'utf8'), 'User guidance');
  const other = join(root, 'other'); mkdirSync(other);
  const linked = join(root, 'linked'); symlinkSync(other, linked, 'junction');
  assert.throws(() => installTeamGuidance(linked), /symbolic links/);
  console.log('Team guidance: idempotence, preservation, removal and symlink refusal passed');
} finally { rmSync(root, { recursive: true, force: true }); }
