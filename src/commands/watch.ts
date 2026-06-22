import { watch as fsWatch, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { repoRoot, repoFullName, currentBranch, memoryEnabled } from "../memory/store.js";
import {
  reindexNow,
  contentFingerprint,
  watcherRunning,
  pidFilePath,
} from "../memory/reindex.js";
import { learnFromCommit } from "../memory/learn.js";
import { c, symbols } from "../ui/colors.js";

// ── `kurtel watch`: réindexation continue, universelle (tout éditeur, pas que Claude Code) ──
// Deux signaux fusionnés vers un même reindex débouncé:
//   1. fs.watch récursif  → faible latence quand la plateforme le supporte.
//   2. poll d'empreinte    → filet universel: capte create/delete ET éditions de
//      contenu même si fs.watch rate des events ou n'est pas récursif (Linux/Node18).
// Single-flight + débounce: une rafale d'écritures d'un agent = un seul reindex.

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cs"]);
const IGNORE_SEG = /(^|[/\\])(node_modules|\.git|dist|build|out|\.next|\.nuxt|coverage|vendor|__pycache__|\.venv|venv|\.kurtel|\.claude|\.idea|\.vscode)([/\\]|$)/;

const DEBOUNCE_MS = 2500;  // attendre le calme avant de reconstruire
const POLL_MS = 10_000;    // cadence du filet de sécurité

export interface WatchOptions {
  daemon?: boolean; // spawné par ensureWatcher: aucune sortie
}

export async function watchCommand(action: string, opts: WatchOptions = {}): Promise<void> {
  const root = repoRoot();

  if (action === "stop") {
    const pid = watcherRunning(root);
    if (!pid) { console.log(`${c.dim("No watcher running for this repo.")}`); return; }
    try { process.kill(pid, "SIGTERM"); } catch { /* déjà mort */ }
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

  // action === "start" (défaut)
  await runDaemon(root, !!opts.daemon);
}

function runDaemon(root: string, silent: boolean): Promise<void> {
  // Pas deux watchers pour le même repo.
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

    // Apprentissage local: tout nouveau commit du dev est un signal. Lecture seule,
    // silencieux, best effort — jamais bloquant pour le reindex.
    function checkCommit(): void {
      if (stopped) return;
      void learnFromCommit(root).catch(() => { /* best effort */ });
    }

    async function fire(): Promise<void> {
      if (running) { dirty = true; return; }
      running = true;
      do {
        dirty = false;
        if (memoryEnabled(root)) {
          const ok = await reindexNow(root);
          if (ok) log(`${symbols.check} ${c.dim(new Date().toISOString())} reindexed ${c.white(repoFullName(root))} ${c.dim(`(${currentBranch(root)})`)}`);
        }
      } while (dirty && !stopped);
      // Resynchronise l'empreinte après coup (les fichiers ont pu changer pendant le build).
      lastFp = contentFingerprint(root);
      running = false;
    }

    function schedule(): void {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void fire(); }, DEBOUNCE_MS);
    }

    // pidfile (le démarrage gagne la course; ensureWatcher a déjà filtré le cas courant).
    try {
      mkdirSync(dirname(pidFilePath(root)), { recursive: true });
      writeFileSync(pidFilePath(root), String(process.pid));
    } catch { /* best effort */ }

    // Signal bas-latence: fs.watch récursif. Peut throw (Linux/Node18 sans support récursif) → poll-only.
    let watcher: ReturnType<typeof fsWatch> | null = null;
    try {
      watcher = fsWatch(root, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const f = filename.toString().replace(/\\/g, "/");
        if (IGNORE_SEG.test("/" + f)) return;
        if (!CODE_EXT.has(extname(f))) return;
        schedule();
      });
      watcher.on("error", () => { /* on garde le poll comme filet */ });
    } catch {
      log(`${c.yellow(symbols.warn)} ${c.dim("recursive watch unavailable — relying on polling.")}`);
    }

    // Signal bas-latence pour les commits: .git/logs/HEAD reçoit une ligne à chaque
    // mouvement de HEAD (commit, reset…). fs.watch dessus → apprentissage immédiat.
    try {
      const gitLog = join(root, ".git", "logs", "HEAD");
      if (existsSync(gitLog)) {
        gitWatcher = fsWatch(gitLog, () => checkCommit());
        gitWatcher.on("error", () => { /* le poll reste le filet */ });
      }
    } catch { /* pas de reflog (worktree/submodule): le poll prend le relais */ }

    // Filet universel: poll d'empreinte de contenu (structure + mtimes) + commits.
    const poll = setInterval(() => {
      if (stopped) return;
      checkCommit(); // peu coûteux: un rev-parse + comparaison, ne fait rien si HEAD inchangé
      if (running) return;
      try {
        const fp = contentFingerprint(root);
        if (fp !== lastFp) { lastFp = fp; schedule(); }
      } catch { /* repo transitoire */ }
    }, POLL_MS);
    // NB: pas de unref() — le poll doit garder le daemon en vie (filet si fs.watch meurt).

    // Baseline: une reconstruction au démarrage garantit un index frais immédiatement.
    lastFp = contentFingerprint(root);
    void fire();
    checkCommit(); // rattrape un éventuel commit fait pendant que le watcher était arrêté

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGHUP", cleanup);

    if (!silent) {
      log(`${symbols.check} Watching ${c.white(repoFullName(root))} ${c.dim(`(branch ${currentBranch(root)}) — reindexing on change. Stop with`)} ${c.indigo("kurtel watch stop")}${c.dim(".")}`);
    }
  });
}
