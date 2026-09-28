import { repoRoot } from "../repository/git.js";
import { loadIndex } from "../storage/graph-index.js";
import { compactContext, type ContextMode } from "../context/compact.js";
import { usageReport } from "../storage/usage.js";

export async function contextCommand(prompt: string, options: { mode?: string; path?: string[]; budget?: string; json?: boolean }) {
  const root = repoRoot(process.cwd());
  const result = await compactContext(root, loadIndex(root), prompt, { mode: (options.mode ?? "action") as ContextMode, paths: options.path, budget: options.budget === undefined ? undefined : Number(options.budget) });
  const { items, ...report } = result;
  console.log(options.json ? JSON.stringify(report, null, 2) : report.text || "No eligible context for this task.");
}

export function contextUsageCommand(options: { json?: boolean }) {
  const report = usageReport(repoRoot(process.cwd()));
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  const pct = (n: number, d: number) => d ? `${Math.round(100 * n / d)} %` : "—";
  console.log(`Sessions: ${report.sessions}. Items injected: ${report.items}; citing a file: ${report.citing}; followed by use: ${report.used} (${pct(report.used, report.citing)}).`);
  for (const [event, e] of Object.entries(report.events)) console.log(`  ${event}: ${e.injections} injections, ${e.tokens} tokens, ${e.used}/${e.citing} used (${pct(e.used, e.citing)})`);
  console.log(`  Memory: ${report.memory.used}/${report.memory.citing} used (${pct(report.memory.used, report.memory.citing)})`);
  console.log(report.definition);
}
