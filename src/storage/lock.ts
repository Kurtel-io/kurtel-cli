import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A lock is abandoned when its owner is dead or it outlived the longest legitimate holder. */
export function lockAbandoned(path: string, staleMs: number): boolean {
  let age: number;
  try { age = Date.now() - statSync(path).mtimeMs; } catch { return false; }
  if (age > staleMs) return true;
  let pid = NaN;
  try { const text = readFileSync(path, "utf8").trim(); pid = text.startsWith("{") ? Number(JSON.parse(text).pid) : Number(text); } catch { /* Unreadable or empty: age alone decides. */ }
  // A lock without a readable owner may still be in its first write; only a dead owner ends it early.
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid);
}

/**
 * Exclusive lock file holding its owner. Returns null while a live holder keeps it.
 * An abandoned lock is moved aside (only one contender wins the rename) and retaken once.
 */
export function acquireLock(path: string, staleMs: number): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt || !lockAbandoned(path, staleMs)) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw error;
      }
      const aside = `${path}.${randomUUID()}.stale`;
      try { renameSync(path, aside); unlinkSync(aside); } catch { return null; }
    }
  }
  return null;
}

export function releaseLock(path: string, fd: number): void {
  closeSync(fd);
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
