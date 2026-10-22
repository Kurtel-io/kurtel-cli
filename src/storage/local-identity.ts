import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Private OS-profile identity, not an authenticated team identity. */
export function localIdentity(create = false): string | null {
  const file = join(homedir(), ".kurtel", "local-identity.json");
  if (!existsSync(file) && create) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ id: `local:${randomUUID()}` }), { mode: 0o600 });
    try { linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { unlinkSync(temporary); }
  }
  if (!existsSync(file)) return null;
  const id = JSON.parse(readFileSync(file, "utf8")).id;
  if (typeof id !== "string" || !/^local:[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid local identity");
  return id;
}

let named: string | null | undefined;
/** The name shown to colleagues with what this person said: `kurtel config set name`, else Git's user.name. */
export function speakerName(): string | null {
  if (named !== undefined) return named;
  let name: unknown = null;
  try { name = JSON.parse(readFileSync(join(homedir(), ".kurtel", "config.json"), "utf8")).name; } catch { /* no config */ }
  if (typeof name !== "string" || !name.trim()) {
    const git = spawnSync("git", ["config", "--global", "user.name"], { encoding: "utf8", timeout: 2000, windowsHide: true });
    name = git.status === 0 ? git.stdout : null;
  }
  return named = cleanName(name);
}

/** A display name: one line, at most 80 characters. */
export function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean || null;
}
