import { currentBranch, headCommit } from "../repository/git.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildIndex, listCodeFiles } from "../graph/indexer.js";
import { resolutionConfigFiles } from "../graph/resolver.js";
import { cacheDir } from "../storage/paths.js";
import { loadIndex, saveIndex } from "../storage/graph-index.js";
import { kurtelEnabled, repoActivated } from "../storage/state.js";
import { pushIndex } from "../memory/api.js";

// Rebuilds the index when the files on disk differ from it, under a cross-process lock.

const STALE_LOCK_MS = 120_000;

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

/** The set of code files. */
export function diskStructureFp(root: string): string {
  return hashList(listCodeFiles(root));
}

/** Content and Git state, including edits that keep timestamps. */
export function contentFingerprint(root: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([currentBranch(root), headCommit(root)]));
  for (const file of resolutionConfigFiles(root)) {
    h.update(file);
    try { h.update(readFileSync(file)); } catch { h.update('<missing>'); }
  }
  for (const rel of listCodeFiles(root)) {
    h.update(JSON.stringify(rel));
    try { h.update(readFileSync(join(root, rel))); }
    catch { h.update("<unreadable>"); }
    h.update("\0");
  }
  return h.digest("hex");
}

/** Whether the set of files changed since the last index. */
export function isStructurallyStale(root: string): boolean {
  const idx = loadIndex(root);
  if (!idx) return true;
  const indexed = hashList(idx.modules.map((m) => m.id).sort());
  return indexed !== diskStructureFp(root);
}

function acquireLock(root: string): boolean {
  ensureCacheDir(root);
  const lp = lockPath(root);
  try {
    if (existsSync(lp)) {
      const age = Date.now() - statSync(lp).mtimeMs;
      const owner = Number(readFileSync(lp, "utf8"));
      if (isAlive(owner) || age < STALE_LOCK_MS) return false;
      rmSync(lp, { force: true });
    }
    writeFileSync(lp, String(process.pid), { flag: "wx" });
    return true;
  } catch { return false; }
}

function releaseLock(root: string): void {
  try { rmSync(lockPath(root), { force: true }); } catch { /* best effort */ }
}

/** Rebuilds and uploads the index. False if another reindex runs, Kurtel is off, or on error. */
export async function reindexNow(root: string, opts: { push?: boolean } = {}): Promise<boolean> {
  if (!repoActivated(root)) return false;
  if (!kurtelEnabled(root)) return false;
  if (!acquireLock(root)) return false;
  try {
    const index = await buildIndex(root);
    saveIndex(root, index);
    if (opts.push !== false) {
      try { await pushIndex(root, index, headCommit(root)); } catch { /* Offline: the local index is current. */ }
    }
    return true;
  } catch {
    return false;
  } finally {
    releaseLock(root);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** PID of the running watcher, or null. */
export function watcherRunning(root: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidFilePath(root), "utf8").trim(), 10);
    if (pid && isAlive(pid)) return pid;
  } catch { /* No pidfile. */ }
  return null;
}

/** Starts the detached watcher unless it runs. */
export function ensureWatcher(root: string): void {
  try {
    if (!repoActivated(root)) return;
    if (!kurtelEnabled(root)) return;
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
