import { watch as fsWatch, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { repoRoot, repoFullName, currentBranch } from "../repository/git.js";
import { kurtelEnabled, repoActivated } from "../storage/state.js";
import {
  reindexNow,
  contentFingerprint,
  watcherRunning,
  pidFilePath,
} from "../runtime/reindex.js";
import { c, symbols } from "../ui/colors.js";

// Two signals feed one debounced reindex:
//   1. recursive fs.watch: low latency where the platform supports it;
//   2. fingerprint polling: catches creates, deletes and edits even when fs.watch misses events or is not
//      recursive (Linux, Node 18).
// Single flight and debounce: a burst of writes from an agent is one reindex.

const CODE_EXT = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cs"]);
const IGNORE_SEG = /(^|[/\\])(node_modules|\.git|dist|build|out|\.next|\.nuxt|coverage|vendor|__pycache__|\.venv|venv|\.kurtel|\.claude|\.idea|\.vscode)([/\\]|$)/;

const DEBOUNCE_MS = 2500;  // wait for quiet before rebuilding
const POLL_MS = 10_000;    // safety-net interval

export interface WatchOptions {
  daemon?: boolean; // started by ensureWatcher: no output
}

export async function watchCommand(action: string, opts: WatchOptions = {}): Promise<void> {
  const root = repoRoot();

  if (action === "stop") {
    const pid = watcherRunning(root);
    if (!pid) { console.log(`${c.dim("No watcher running for this repo.")}`); return; }
    try { process.kill(pid, "SIGTERM"); } catch { /* */ }
    try { rmSync(pidFilePath(root), { force: true }); } catch { /* */ }
    console.log(`${symbols.check} Watcher stopped ${c.dim(`(pid ${pid})`)}.`);
    return;
  }

  if (action === "status") {
    const pid = watcherRunning(root);
    if (pid) console.log(`${symbols.check} Watching ${c.white(repoFullName(root))} ${c.dim(`(branch ${currentBranch(root)}, pid ${pid})`)}`);
    else console.log(`${c.dim("Watcher: not running. Auto-starts on")} ${c.indigo("kurtel onboard")} ${c.dim("or a Claude Code session.")}`);
    return;
  }

  // action === "start" (default)
  if (!repoActivated(root)) {
    // No watcher (so no .kurtel/, no index, no upload) until the repository is activated.
    if (!opts.daemon) {
      console.log(`${c.yellow(symbols.warn)} Kurtel is not activated in this repo — run ${c.indigo("kurtel onboard")} first ${c.dim("(or `kurtel memory on` to activate without indexing).")}`);
    }
    return;
  }
  await runDaemon(root, !!opts.daemon);
}

function runDaemon(root: string, silent: boolean): Promise<void> {
  // One watcher per repository.
  const existing = watcherRunning(root);
  if (existing && existing !== process.pid) {
    if (!silent) console.log(`${c.dim(`Watcher already running (pid ${existing}).`)}`);
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let lastFp = "";
    let timer: NodeJS.Timeout | null = null;
    let running = false;
    let dirty = false;
    let stopped = false;
    let gitWatcher: ReturnType<typeof fsWatch> | null = null;

    const log = (s: string) => { if (!silent) console.log(s); };

    function cleanup(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      try { watcher?.close(); } catch { /* */ }
      try { gitWatcher?.close(); } catch { /* */ }
      try { rmSync(pidFilePath(root), { force: true }); } catch { /* */ }
      resolve();
    }

    async function fire(): Promise<void> {
      if (running) { dirty = true; return; }
      running = true;
      try {
        do {
          dirty = false;
          const before = contentFingerprint(root);
          if (!kurtelEnabled(root)) break;
          const ok = await reindexNow(root);
          if (!ok) break; // Keep the previous fingerprint so polling retries.
          lastFp = before;
          dirty = dirty || contentFingerprint(root) !== before;
          log(`${symbols.check} ${c.dim(new Date().toISOString())} reindexed ${c.white(repoFullName(root))} ${c.dim(`(${currentBranch(root)})`)}`);
        } while (dirty && !stopped);
      } catch {
        // A transient checkout/read error is retried by the next poll.
      } finally {
        running = false;
      }
    }

    function schedule(): void {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void fire(); }, DEBOUNCE_MS);
    }

    // pidfile (the first start wins; ensureWatcher already filtered the common case).
    try {
      mkdirSync(dirname(pidFilePath(root)), { recursive: true });
      writeFileSync(pidFilePath(root), String(process.pid));
    } catch { /* best effort */ }

    // Low-latency signal: recursive fs.watch. May throw (Linux, Node 18): polling only then.
    let watcher: ReturnType<typeof fsWatch> | null = null;
    try {
      watcher = fsWatch(root, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const f = filename.toString().replace(/\\/g, "/");
        if (IGNORE_SEG.test("/" + f)) return;
        if (!CODE_EXT.has(extname(f))) return;
        schedule();
      });
      watcher.on("error", () => { /* */ });
    } catch {
      log(`${c.yellow(symbols.warn)} ${c.dim("recursive watch unavailable — relying on polling.")}`);
    }

    // Low-latency signal: .git/logs/HEAD gets a line on every HEAD move (commit, reset, branch switch).
    try {
      const gitLog = join(root, ".git", "logs", "HEAD");
      if (existsSync(gitLog)) {
        gitWatcher = fsWatch(gitLog, () => { schedule(); });
        gitWatcher.on("error", () => { /* */ });
      }
    } catch { /* */ }

    const poll = setInterval(() => {
      if (stopped) return;
      if (running) return;
      try {
        const fp = contentFingerprint(root);
        if (fp !== lastFp) schedule();
      } catch { /* */ }
    }, POLL_MS);

    // Baseline: a rebuild at start gives a fresh index at once.
    lastFp = contentFingerprint(root);
    void fire();

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGHUP", cleanup);

    if (!silent) {
      log(`${symbols.check} Watching ${c.white(repoFullName(root))} ${c.dim(`(branch ${currentBranch(root)}) — reindexing on change. Stop with`)} ${c.indigo("kurtel watch stop")}${c.dim(".")}`);
    }
  });
}
