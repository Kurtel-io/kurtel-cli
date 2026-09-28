import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** host/path of a remote URL, lower case, as kurtel.io matches declared repositories. Null for a local path. */
export function normalizeRemote(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let v = url.trim().toLowerCase();
  v = v.replace(/[?#].*$/, "");
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.replace(/^[^@/]+@/, "");
  v = v.replace(/^([^/:]+):[0-9]+(\/|$)/, "$1$2");
  v = v.replace(/^([^/:]+):\/?/, "$1/");
  v = v.replace(/^www\./, "");
  v = v.replace(/^ssh\.dev\.azure\.com\/v3\//, "dev.azure.com/");
  v = v.replace(/\/_git\//, "/");
  v = v.replace(/\/{2,}/g, "/");
  v = v.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return /^([a-z0-9-]+(\.[a-z0-9-]+)+|localhost)(\/[^/\s]+){2,}$/.test(v) ? v : null;
}

/** The origin URL from .git/config, without starting Git. */
function originFromConfig(root: string): string | null | undefined {
  try {
    if (!statSync(join(root, ".git")).isDirectory()) return undefined;
    const config = readFileSync(join(root, ".git", "config"), "utf8");
    let inOrigin = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[(.+)\]\s*$/.exec(line);
      if (section) { inOrigin = /^remote\s+"origin"$/.test(section[1].trim()); continue; }
      const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
      if (url) return url[1];
    }
    return null;
  } catch { return undefined; }
}

const remotes = new Map<string, string | null>();
/** Normalized origin remote, or null. */
export function originRemote(root: string): string | null {
  if (remotes.has(root)) return remotes.get(root)!;
  let raw = originFromConfig(root);
  if (raw === undefined) {
    try { raw = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString().trim(); }
    catch { raw = null; }
  }
  const remote = normalizeRemote(raw);
  remotes.set(root, remote);
  return remote;
}
