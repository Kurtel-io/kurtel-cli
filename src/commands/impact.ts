import { c, symbols } from "../ui/colors.js";
import { repoRoot, loadIndex } from "../memory/store.js";
import { resolveTarget, computeImpact, renderImpactForAgent } from "../memory/impact.js";

export async function impactCommand(
  target: string | undefined,
  opts: { json?: boolean; depth?: string } = {}
): Promise<void> {
  if (!target) {
    console.log(`${c.red(symbols.cross)} Usage: ${c.indigo('kurtel impact <file | file::function | function>')}`);
    process.exitCode = 1;
    return;
  }
  const root = repoRoot();
  const index = loadIndex(root);
  if (!index) {
    console.log(`${c.red(symbols.cross)} No index. Run ${c.indigo("kurtel onboard")} first.`);
    process.exitCode = 1;
    return;
  }
  const resolved = resolveTarget(index, target);
  if (!resolved) {
    console.log(`${c.red(symbols.cross)} Target ${c.white(target)} not found (or ambiguous — use file::function).`);
    process.exitCode = 1;
    return;
  }
  const depth = Math.min(6, Math.max(1, parseInt(opts.depth ?? "4", 10) || 4));
  const result = computeImpact(index, resolved, depth);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result));
    return;
  }
  console.log("");
  console.log(renderImpactForAgent(result));
  console.log("");
}
