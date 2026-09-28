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
