import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keep the existing on-disk defaults and tolerate absent or corrupt caches.
export function readJSON<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}

export function writeJSON(file: string, data: unknown): void {
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}
