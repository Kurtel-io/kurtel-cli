import { c, symbols } from "../ui/colors.js";
import { Spinner } from "../ui/spinner.js";
import { repoRoot, headCommit } from "../repository/git.js";
import { loadIndex, indexGeneratedAt } from "../storage/graph-index.js";
import { kurtelEnabled, memoryEnabled, memorySwitchOn, setMemoryEnabled, memoryDisabledGlobally, repoActivated, activateRepo } from "../storage/state.js";
import { accessGated, accessMemory } from "../storage/access.js";
import { injectionLogPath } from "../storage/paths.js";
import { readInjectionLog, clearInjectionLog } from "../storage/journal.js";
import { disableSharing, enableSharing, sharedConfig, syncShared } from "../memory/shared.js";
import { setConfigValue } from "../lib/config.js";
import { importVecFile, vectorsInfo } from "../context/embeddings.js";
import { compactContext } from "../context/compact.js";

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
      activateRepo(root);
      console.log(`${symbols.check} Kurtel memory ${c.indigo("enabled")} for this repo.`);
      if (accessGated() && repoActivated(root) && !accessMemory(root)) {
        console.log(`${c.yellow(symbols.warn)} ${c.dim("Memory is not included for this repository's organization: Kurtel gives the agent the codebase graph only.")}`);
      }
      if (!kurtelEnabled(root)) {
        console.log(`${c.yellow(symbols.warn)} ${c.dim("Kurtel is off in this repository — turn it back on with")} ${c.indigo("kurtel on")}${c.dim(".")}`);
      }
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
      console.log(`${symbols.check} Kurtel memory ${c.yellow("disabled")} for this repo ${c.dim("(the codebase graph stays on; kurtel off turns Kurtel off entirely)")}.`);
      return;

    case "sync": {
      // Shared knowledge: send what was judged, receive teammates' knowledge.
      const result = await syncShared(root);
      if (!opts.quiet) console.log(result ? `Synced · ${result.pushed} sent · ${result.pulled} received` : c.dim("Sharing off (kurtel memory share on), or a synchronization is already running."));
      return;
    }

    case "share": {
      // Shared knowledge: on [endpoint] | off | status | now
      const sub = args[0] ?? "status";
      if (sub === "on") { const config = enableSharing(root, args[1]); console.log(`${c.green(symbols.check)} Knowledge shared for ${c.white(config.repo)} via ${c.dim(config.endpoint)}. Conversations stay on this machine.`); return; }
      if (sub === "off") { disableSharing(root); console.log("Knowledge sharing off for this repository; local memory unchanged."); return; }
      if (sub === "now") {
        const result = await syncShared(root);
        if (!opts.quiet) console.log(result ? `Shared · ${result.pushed} sent · ${result.pulled} received` : c.dim("Sharing off, or a synchronization is already running."));
        return;
      }
      const config = sharedConfig(root);
      if (opts.json) { process.stdout.write(JSON.stringify(config ? { enabled: config.enabled, endpoint: config.endpoint, repo: config.repo, cursor: config.cursor, sent: config.pushed.length, received: config.adopted.length } : { enabled: false }) + "\n"); return; }
      console.log(config?.enabled ? `${c.gray("sharing")}   on · ${config.repo} · ${config.pushed.length} sent · ${config.adopted.length} received · ${c.dim(config.endpoint)}` : `${c.gray("sharing")}   off ${c.dim("(kurtel memory share on)")}`);
      return;
    }
    case "log": {
      // Local journal of everything Kurtel injected, prompt by prompt.
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
      // Preview the current selection without consuming a session's delivery ledger.
      const prompt = (args ?? []).join(" ").trim();
      if (!prompt) {
        console.log(`${c.red(symbols.cross)} Usage: ${c.indigo('kurtel memory preview "<your prompt>"')}`);
        process.exitCode = 1;
        return;
      }

      const index = loadIndex(root);
      const enabled = kurtelEnabled(root);

      // Same guards as the hook: short prompts and slash commands stay silent.
      const skipped = !repoActivated(root)
        ? "repo is not activated (`kurtel onboard` or `kurtel memory on`)"
        : !enabled
        ? "Kurtel is off in this repository (`kurtel on`)"
        : prompt.length < 8
        ? "prompt is under 8 chars — the hook stays silent"
        : prompt.startsWith("/")
        ? "prompt is a slash command — the hook stays silent"
        : null;

      const capsule = skipped ? null : await compactContext(root, index, prompt);

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          prompt,
          would_inject: Boolean(capsule?.text),
          skipped_reason: skipped,
          text: capsule?.text ?? null,
          tokens: capsule?.tokens ?? 0,
          tokenizer: capsule?.tokenizer,
          omitted: capsule?.omitted ?? [],
          warnings: capsule?.warnings ?? [],
          session_deduplication_applied: false,
          zones: capsule?.zones ?? [],
        }));
        return;
      }

      console.log("");
      console.log(`${c.gray("prompt")}    ${c.white(prompt)}`);
      if (!capsule?.text) {
        console.log(`${c.gray("inject")}    ${c.yellow("○ nothing")} ${c.dim(`— ${skipped ?? "no relevant context (silence is the default)"}`)}`);
        console.log("");
        return;
      }
      console.log(`${c.gray("inject")}    ${c.indigo("● capsule")} ${c.dim(`(${capsule.tokens} ${capsule.tokenizer} tokens · zones: ${capsule.zones.join(", ") || "none"})`)}`);
      console.log(c.dim("─".repeat(60)));
      console.log(capsule.text);
      console.log(c.dim("─".repeat(60)));
      console.log(c.dim("Preview before session deduplication. Hooks may omit context already delivered; token count uses a local reference tokenizer."));
      console.log("");
      return;
    }

    case undefined:
    case "status": {
      const activated = repoActivated(root);
      const globalOff = memoryDisabledGlobally();
      const on = kurtelEnabled(root);
      const enabled = memoryEnabled(root) && activated;
      // Memory included in the organization's plan (always, in an enterprise deployment).
      const included = !accessGated() || accessMemory(root);
      const index = loadIndex(root);

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          kurtel: on,
          enabled,
          included,
          activated,
          global_off: globalOff,
          index: index ? { files: index.files_indexed, routes: index.routes.length, commit: headCommit(root), generated_at: indexGeneratedAt(root) } : null,
        }));
        return;
      }

      console.log("");
      const state = !activated
        ? `${c.yellow("○ not activated")} ${c.dim("— run `kurtel onboard` (or `kurtel memory on`) to opt this repo in")}`
        : !on
        ? `${c.yellow("○ Kurtel off")} ${c.dim("— graph and memory; `kurtel on` to turn it back on")}`
        : !included
        ? `${c.yellow("○ graph only")} ${c.dim("— memory is not included for this repository's organization")}`
        : globalOff
        ? `${c.yellow("○ disabled globally")} ${c.dim("(`kurtel memory on --global` to lift)")}`
        : enabled
        ? c.indigo("● active")
        : !memorySwitchOn(root)
        ? `${c.yellow("○ graph only")} ${c.dim("— memory turned off here (`kurtel memory on`)")}`
        : c.yellow("○ disabled");
      console.log(`${c.gray("memory")}    ${state}`);
      if (index) {
        console.log(`${c.gray("index")}     ${c.white(`${index.files_indexed} files · ${index.routes.length} routes`)} ${c.dim(`(${ago(indexGeneratedAt(root))}, commit ${headCommit(root).slice(0, 8)})`)}`);
      } else {
        console.log(`${c.gray("index")}     ${c.dim("none — run `kurtel onboard`")}`);
      }
      console.log("");
      return;
    }

    default:
      console.log(
        `${c.red(symbols.cross)} Unknown action ${c.white(action)}. Try ${c.indigo("status")}, ${c.indigo("on")}, ${c.indigo("off")}, ${c.indigo("sync")}, ${c.indigo("share")}, ${c.indigo("preview")}, or ${c.indigo("log")}.`
      );
      process.exitCode = 1;
  }
}
