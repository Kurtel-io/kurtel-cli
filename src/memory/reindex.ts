import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildIndex, listCodeFiles } from "./indexer.js";
import { cacheDir, loadIndex, saveIndex, memoryEnabled } from "./store.js";
import { syncIndexUp } from "./sync.js";

// ── Réindexation continue ────────────────────────────────────────────────────
// Principe: on ne traque pas les événements, on réconcilie l'état. On compare la
// vérité disque à la vérité de l'index, et on reconstruit quand ça diffère. Tout
// passe par un verrou cross-process: jamais deux réindex en parallèle.

const STALE_LOCK_MS = 120_000; // un lock plus vieux que ça = process mort, on l'ignore

function lockPath(root: string): string { return join(cacheDir(root), "reindex.lock"); }
export function pidFilePath(root: string): string { return join(cacheDir(root), "watch.pid"); }

function ensureCacheDir(root: string): void {
  const d = cacheDir(root);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function hashList(items: string[]): string {
  const h = createHash("sha1");
  for (const it of items) h.update(it + "\n");
  return h.digest("hex");
}

/** Empreinte STRUCTURELLE: l'ensemble des fichiers de code (create/delete/rename). */
export function diskStructureFp(root: string): string {
  return hashList(listCodeFiles(root));
}

/** Empreinte de CONTENU: chemins + mtimes — capte aussi les éditions internes. */
export function contentFingerprint(root: string): string {
  const h = createHash("sha1");
  for (const rel of listCodeFiles(root)) {
    let m = 0;
    try { m = statSync(join(root, rel)).mtimeMs; } catch { /* fichier disparu en cours de route */ }
    h.update(`${rel}:${Math.floor(m)}\n`);
  }
  return h.digest("hex");
}

/** True si l'ensemble des fichiers a changé depuis le dernier index (les ids modules = fichiers indexés). */
export function isStructurallyStale(root: string): boolean {
  const idx = loadIndex(root);
  if (!idx) return true; // aucun index → à (re)construire
  const indexed = hashList(idx.modules.map((m) => m.id).sort());
  return indexed !== diskStructureFp(root);
}

// ── Verrou cross-process ──────────────────────────────────────────────────────

function acquireLock(root: string): boolean {
  ensureCacheDir(root);
  const lp = lockPath(root);
  try {
    if (existsSync(lp)) {
      const age = Date.now() - statSync(lp).mtimeMs;
      if (age < STALE_LOCK_MS) return false; // un reindex est déjà en cours
    }
    writeFileSync(lp, String(process.pid));
    return true;
  } catch { return false; }
}

function releaseLock(root: string): void {
  try { rmSync(lockPath(root), { force: true }); } catch { /* best effort */ }
}

/**
 * Reconstruit l'index puis le pousse au cloud (par branche, via syncIndexUp).
 * Verrouillé: retourne false sans rien faire si un autre reindex tourne, si la
 * mémoire est off, ou en cas d'erreur. Jamais bloquant pour l'appelant ailleurs.
 */
export async function reindexNow(root: string, opts: { push?: boolean } = {}): Promise<boolean> {
  if (!memoryEnabled(root)) return false;
  if (!acquireLock(root)) return false;
  try {
    const index = await buildIndex(root);
    saveIndex(root, index);
    if (opts.push !== false) {
      try { await syncIndexUp(root); } catch { /* offline / pas loggé: l'index local reste à jour */ }
    }
    return true;
  } catch {
    return false;
  } finally {
    releaseLock(root);
  }
}

// ── Cycle de vie du watcher (un daemon détaché par repo) ──────────────────────

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** PID du watcher en cours pour ce repo, ou null. */
export function watcherRunning(root: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidFilePath(root), "utf8").trim(), 10);
    if (pid && isAlive(pid)) return pid;
  } catch { /* pas de pidfile */ }
  return null;
}

/** Démarre le watcher détaché s'il ne tourne pas déjà — silencieux, fire & forget. */
export function ensureWatcher(root: string): void {
  try {
    if (!memoryEnabled(root)) return;
    if (watcherRunning(root)) return;
    const child = spawn(process.execPath, [process.argv[1], "watch", "start", "--daemon"], {
      cwd: root,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  } catch { /* best effort */ }
}
