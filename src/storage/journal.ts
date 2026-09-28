import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync, rmSync } from "node:fs";
import { injectionLogPath, injectedIdsPath } from "./paths.js";

const INJECTION_LOG_MAX_BYTES = 1_500_000;

/** Keeps Kurtel's machine-specific files out of Git: the code map, the report and the injection journal. */
export function ensureKurtelIgnored(root: string): void {
  const gi = join(root, ".kurtel", ".gitignore");
  try {
    const want = ["index.json", "REPORT.md", "injection-log.md", "injection-log.old.md", "injected.jsonl"];
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
    const missing = want.filter((w) => !have.has(w));
    if (!missing.length) return;
    mkdirSync(join(root, ".kurtel"), { recursive: true });
    const header = cur ? "" : "# Built on each machine by Kurtel: never commit\n";
    appendFileSync(gi, header + missing.join("\n") + "\n", "utf8");
  } catch { /* Best effort. */ }
}

// Logging must never prevent context injection. Rotate by renaming.
export function appendInjectionLog(root: string, entry: string): void {
  if (process.env.KURTEL_NO_INJECTION_LOG) return;
  try {
    const file = injectionLogPath(root);
    const dir = join(file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) ensureKurtelIgnored(root); // once, when the file is created
    try {
      if (statSync(file).size > INJECTION_LOG_MAX_BYTES) {
        const old = file.replace(/\.md$/, ".old.md");
        try { rmSync(old); } catch { /* no previous generation */ } // Windows: rename fails if the target exists
        renameSync(file, old);
      }
    } catch { /* No file yet: first write. */ }
    appendFileSync(file, entry, "utf8");
  } catch { /* The journal never breaks injection. */ }
}

export function readInjectionLog(root: string, maxBytes = 8000): string | null {
  try {
    const file = injectionLogPath(root);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    if (!text.trim()) return null;
    return text.length > maxBytes ? "…\n" + text.slice(-maxBytes) : text;
  } catch {
    return null;
  }
}

export function clearInjectionLog(root: string): void {
  for (const f of [
    injectionLogPath(root),
    injectionLogPath(root).replace(/\.md$/, ".old.md"),
    injectedIdsPath(root),
  ]) {
    try { rmSync(f); } catch { /* Already gone. */ }
  }
}
