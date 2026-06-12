import { c, symbols } from "../ui/colors.js";
import { Spinner } from "../ui/spinner.js";
import {
  repoRoot,
  loadIndex,
  loadMemoryCache,
  memoryEnabled,
  setMemoryEnabled,
} from "../memory/store.js";
import { syncNow } from "../memory/sync.js";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function memoryCommand(
  action?: string,
  opts: { quiet?: boolean; json?: boolean } = {}
): Promise<void> {
  const root = repoRoot();

  switch (action) {
    case "on":
      setMemoryEnabled(root, true);
      console.log(`${symbols.check} Kurtel memory ${c.indigo("enabled")} for this repo.`);
      return;

    case "off":
      setMemoryEnabled(root, false);
      console.log(`${symbols.check} Kurtel memory ${c.yellow("disabled")} for this repo ${c.dim("(hooks stay installed, injection is skipped)")}.`);
      return;

    case "sync": {
      const spin = opts.quiet ? null : new Spinner("Syncing memory…").start();
      const res = await syncNow(root);
      spin?.succeed(`Synced · ${res.pulled} patterns pulled · ${res.flushed} telemetry events flushed`);
      return;
    }

    case "patterns": {
      const cache = loadMemoryCache(root);
      if (opts.json) { process.stdout.write(JSON.stringify(cache.patterns)); return; }
      if (!cache.patterns.length) {
        console.log(c.dim("No patterns yet. They are learned from merged PRs and pulled with `kurtel memory sync`."));
        return;
      }
      console.log("");
      for (const p of [...cache.patterns].sort((a, b) => b.score - a.score)) {
        const bar = "█".repeat(Math.round(p.score * 10)).padEnd(10, "░");
        const zones = p.zones.length ? p.zones.join(", ") : "global";
        console.log(`${c.indigo(bar)} ${c.dim(String(Math.round(p.score * 100)).padStart(3) + "%")} ${p.pinned ? c.yellow("★ ") : "  "}${c.white(p.rule)}`);
        console.log(`             ${c.gray("zones")} ${c.dim(zones)} ${c.gray("· evidence")} ${c.dim(String(p.evidence.length) + " PRs")}`);
      }
      console.log("");
      return;
    }

    case undefined:
    case "status": {
      const enabled = memoryEnabled(root);
      const index = loadIndex(root);
      const cache = loadMemoryCache(root);

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          enabled,
          index: index ? { files: index.files_indexed, routes: index.routes.length, commit: index.commit, generated_at: index.generated_at } : null,
          patterns: cache.patterns.length,
          synced_at: cache.patterns_synced_at,
          pending_telemetry: cache.pending_telemetry.length,
        }));
        return;
      }

      console.log("");
      console.log(`${c.gray("memory")}    ${enabled ? c.indigo("● active") : c.yellow("○ disabled")}`);
      if (index) {
        console.log(`${c.gray("index")}     ${c.white(`${index.files_indexed} files · ${index.routes.length} routes`)} ${c.dim(`(${ago(index.generated_at)}, commit ${index.commit.slice(0, 8)})`)}`);
      } else {
        console.log(`${c.gray("index")}     ${c.dim("none — run `kurtel onboard`")}`);
      }
      console.log(`${c.gray("patterns")}  ${c.white(String(cache.patterns.length))} ${c.dim(`(synced ${ago(cache.patterns_synced_at)})`)}`);
      if (cache.pending_telemetry.length) {
        console.log(`${c.gray("pending")}   ${c.dim(`${cache.pending_telemetry.length} telemetry events (flushed on next sync)`)}`);
      }
      console.log("");
      return;
    }

    default:
      console.log(
        `${c.red(symbols.cross)} Unknown action ${c.white(action)}. Try ${c.indigo("status")}, ${c.indigo("on")}, ${c.indigo("off")}, ${c.indigo("sync")}, or ${c.indigo("patterns")}.`
      );
      process.exitCode = 1;
  }
}
