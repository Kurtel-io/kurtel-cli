import { c, symbols } from "../ui/colors.js";
import { Spinner } from "../ui/spinner.js";
import {
  repoRoot,
  loadIndex,
  loadMemoryCache,
  headCommit,
  indexGeneratedAt,
  memoryEnabled,
  setMemoryEnabled,
  memoryDisabledGlobally,
  repoActivated,
  activateRepo,
  injectionLogPath,
  readInjectionLog,
  clearInjectionLog,
} from "../memory/store.js";
import { syncNow } from "../memory/sync.js";
import { setConfigValue } from "../lib/config.js";
import { importVecFile, vectorsInfo } from "../memory/embed.js";
import { compileCapsule } from "../memory/capsule.js";

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
  opts: { quiet?: boolean; json?: boolean; max?: string; out?: string; global?: boolean } = {},
  args: string[] = []
): Promise<void> {
  const root = repoRoot();

  switch (action) {
    case "vectors": {
      const sub = args[0] ?? "status";
      if (sub === "import") {
        const file = args[1];
        if (!file) {
          console.log(`${c.red(symbols.cross)} Usage: ${c.indigo("kurtel memory vectors import <file.vec>")} ${c.dim("[--max N]")}`);
          process.exitCode = 1;
          return;
        }
        const spin = opts.quiet ? null : new Spinner(`Importing aligned vectors from ${file}…`).start();
        try {
          const res = await importVecFile(file, {
            max: opts.max ? Number(opts.max) : undefined,
            outDir: opts.out,
            onProgress: (n) => spin?.update(`Importing aligned vectors… ${n.toLocaleString()} words`),
          });
          spin?.succeed(`Vectors ready · ${res.added.toLocaleString()} new · ${res.total.toLocaleString()} total · ${res.dim}d → ${res.dir}`);
          console.log(c.dim(`Run \`kurtel onboard\` to embed this repo's modules into the new space.`));
        } catch (e) {
          spin?.fail(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
          process.exitCode = 1;
        }
        return;
      }
      // status
      const info = vectorsInfo();
      if (info) console.log(`${c.gray("vectors")}   ${c.white(`${info.words.toLocaleString()} words · ${info.dim}d`)} ${c.dim("(aligned table installed)")}`);
      else console.log(c.dim("No aligned vectors table. Import one: `kurtel memory vectors import <file.vec>` (e.g. a fastText aligned .vec)."));
      return;
    }
    case "on":
      if (opts.global) {
        setConfigValue("memoryDisabled", false);
        console.log(`${symbols.check} Global kill switch ${c.indigo("lifted")} — memory follows each repo's own on/off state again.`);
        return;
      }
      // `on` vaut opt-in explicite: active aussi les repos jamais onboardés
      // (état local hors repo — n'écrit rien dans le dossier).
      activateRepo(root);
      console.log(`${symbols.check} Kurtel memory ${c.indigo("enabled")} for this repo.`);
      if (memoryDisabledGlobally()) {
        console.log(`${c.yellow(symbols.warn)} ${c.dim("Note: the global kill switch is on — lift it with")} ${c.indigo("kurtel memory on --global")}${c.dim(".")}`);
      }
      return;

    case "off":
      if (opts.global) {
        setConfigValue("memoryDisabled", true);
        console.log(`${symbols.check} Kurtel memory ${c.yellow("disabled everywhere")} ${c.dim("(all repos, this machine — re-enable with `kurtel memory on --global`)")}.`);
        return;
      }
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

    case "log": {
      // Journal local de TOUT ce que la mémoire a injecté, prompt par prompt.
      const file = injectionLogPath(root);
      if (args[0] === "clear") {
        clearInjectionLog(root);
        console.log(`${symbols.check} Injection journal cleared.`);
        return;
      }
      if (args[0] === "path") { console.log(file); return; }

      const tail = readInjectionLog(root, opts.max ? Number(opts.max) : 8000);
      if (!tail) {
        console.log(c.dim("No injections logged yet. The journal fills as you prompt with memory active."));
        console.log(c.dim(`It will appear at ${file} (gitignored).`));
        return;
      }
      console.log("");
      console.log(`${c.gray("journal")}   ${c.dim(file)} ${c.dim("(gitignored · newest last)")}`);
      console.log(c.dim("─".repeat(60)));
      process.stdout.write(tail.endsWith("\n") ? tail : tail + "\n");
      console.log(c.dim("─".repeat(60)));
      console.log(c.dim(`Open the file for the full history · ${c.indigo("kurtel memory log clear")} to reset.`));
      console.log("");
      return;
    }

    case "preview":
    case "inspect": {
      // Montre EXACTEMENT ce que le hook `user-prompt-submit` injecterait pour un
      // prompt donné. L'injection est déterministe et locale → ce preview EST ce
      // que Claude Code reçoit, pas une approximation. (cf. hook.ts:onPrompt)
      const prompt = (args ?? []).join(" ").trim();
      if (!prompt) {
        console.log(`${c.red(symbols.cross)} Usage: ${c.indigo('kurtel memory preview "<your prompt>"')}`);
        process.exitCode = 1;
        return;
      }

      const index = loadIndex(root);
      const cache = loadMemoryCache(root);
      const enabled = memoryEnabled(root);

      // Mêmes gardes que le hook: prompts trop courts ou slash-commands = silence.
      const skipped = !repoActivated(root)
        ? "repo is not activated (`kurtel onboard` or `kurtel memory on`)"
        : !enabled
        ? "memory is disabled for this repo (`kurtel memory on`)"
        : prompt.length < 8
        ? "prompt is under 8 chars — the hook stays silent"
        : prompt.startsWith("/")
        ? "prompt is a slash command — the hook stays silent"
        : null;

      const capsule = skipped ? null : compileCapsule(index, cache.patterns, prompt, root);

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          prompt,
          would_inject: Boolean(capsule),
          skipped_reason: skipped,
          text: capsule?.text ?? null,
          injected_pattern_ids: capsule?.injectedPatternIds ?? [],
          zones: capsule?.zones ?? [],
        }));
        return;
      }

      console.log("");
      console.log(`${c.gray("prompt")}    ${c.white(prompt)}`);
      if (!capsule) {
        console.log(`${c.gray("inject")}    ${c.yellow("○ nothing")} ${c.dim(`— ${skipped ?? "no relevant context (silence is the default)"}`)}`);
        console.log("");
        return;
      }
      console.log(`${c.gray("inject")}    ${c.indigo("● capsule")} ${c.dim(`(${capsule.text.length} chars · ${capsule.injectedPatternIds.length} patterns · zones: ${capsule.zones.join(", ") || "none"})`)}`);
      console.log(c.dim("─".repeat(60)));
      console.log(capsule.text);
      console.log(c.dim("─".repeat(60)));
      console.log(c.dim("This is the exact text added to the agent's context for this prompt."));
      console.log("");
      return;
    }

    case undefined:
    case "status": {
      const activated = repoActivated(root);
      const globalOff = memoryDisabledGlobally();
      const enabled = memoryEnabled(root) && activated;
      const index = loadIndex(root);
      const cache = loadMemoryCache(root);

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          enabled,
          activated,
          global_off: globalOff,
          index: index ? { files: index.files_indexed, routes: index.routes.length, commit: headCommit(root), generated_at: indexGeneratedAt(root) } : null,
          patterns: cache.patterns.length,
          synced_at: cache.patterns_synced_at,
          pending_telemetry: cache.pending_telemetry.length,
        }));
        return;
      }

      console.log("");
      const state = !activated
        ? `${c.yellow("○ not activated")} ${c.dim("— run `kurtel onboard` (or `kurtel memory on`) to opt this repo in")}`
        : globalOff
        ? `${c.yellow("○ disabled globally")} ${c.dim("(`kurtel memory on --global` to lift)")}`
        : enabled
        ? c.indigo("● active")
        : c.yellow("○ disabled");
      console.log(`${c.gray("memory")}    ${state}`);
      if (index) {
        console.log(`${c.gray("index")}     ${c.white(`${index.files_indexed} files · ${index.routes.length} routes`)} ${c.dim(`(${ago(indexGeneratedAt(root))}, commit ${headCommit(root).slice(0, 8)})`)}`);
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
        `${c.red(symbols.cross)} Unknown action ${c.white(action)}. Try ${c.indigo("status")}, ${c.indigo("on")}, ${c.indigo("off")}, ${c.indigo("sync")}, ${c.indigo("patterns")}, ${c.indigo("preview")}, or ${c.indigo("log")}.`
      );
      process.exitCode = 1;
  }
}
