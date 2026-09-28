import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { apiUrl, loadConfig } from "../lib/config.js";
import { cloudAllowed, networkPolicy, policyFetch } from "../security/network.js";
import { originRemote } from "../repository/remote.js";

// The developer's access to a folder's repository, kept per folder. A granted access does not expire (a refused
// synchronization revokes it); a refusal or an answer without memory is asked again at each session start.

export interface OrganizationRef { id: string; slug: string; name: string }
export type AccessReason = "not_signed_in" | "invalid_remote" | "not_declared" | "no_access" | "organization_required";
export interface AccessEntry {
  remote: string;
  active: boolean;
  checked_at: string;
  reason?: AccessReason;
  organization?: OrganizationRef;
  repository_id?: string;
  role?: string;
  memory?: boolean;
  organizations?: OrganizationRef[];
  chosen?: string;                   // kurtel org use
}
interface AccessFile { version: 1; entries: Record<string, AccessEntry>; purge?: string[] }

const file = () => join(homedir(), ".kurtel", "access.json");
// Re-read when the file changes.
let memo: { data: AccessFile; path: string; mtime: number; size: number } | null = null;

function read(): AccessFile {
  const path = file();
  let mtime = -1, size = -1;
  try { const s = statSync(path); mtime = s.mtimeMs; size = s.size; } catch { /* no file yet */ }
  if (memo && memo.path === path && memo.mtime === mtime && memo.size === size) return memo.data;
  let data: AccessFile = { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") data = parsed;
  } catch { /* missing or unreadable: no answer kept */ }
  memo = { data, path, mtime, size };
  return data;
}
function write(data: AccessFile): void {
  const target = file();
  mkdirSync(join(homedir(), ".kurtel"), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, target);
  memo = null;
}

/** One entry per real folder path (case-insensitive on Windows). */
function folderKey(root: string): string {
  let path = resolve(root);
  try { path = realpathSync.native(path); } catch { /* missing folder: resolved path */ }
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Activation follows kurtel.io access, except in an enterprise deployment (or with KURTEL_ACTIVATION=markers). */
export function accessGated(): boolean {
  return networkPolicy().mode === "cloud" && process.env.KURTEL_ACTIVATION !== "markers";
}

/** The kept answer for this folder's current remote. */
export function accessEntry(root: string): AccessEntry | null {
  const remote = originRemote(root);
  if (!remote) return null;
  const entry = read().entries[folderKey(root)];
  return entry && entry.remote === remote ? entry : null;
}

/** The granted access for this folder, or null. */
export function activeAccess(root: string): (AccessEntry & { organization: OrganizationRef; repository_id: string }) | null {
  const entry = accessEntry(root);
  return entry?.active && entry.organization && entry.repository_id ? entry as AccessEntry & { organization: OrganizationRef; repository_id: string } : null;
}

/** Whether the organization's plan includes memory. */
export function accessMemory(root: string): boolean {
  return activeAccess(root)?.memory === true;
}

/** memory_not_enabled from the server: graph only in every folder of that repository; access and data kept. */
export function withholdMemory(root: string): void {
  const entry = activeAccess(root);
  if (!entry || entry.memory === false) return;
  const data = read();
  const entries = { ...data.entries };
  for (const [key, e] of Object.entries(entries)) {
    if (e.active && e.organization?.id === entry.organization.id && e.repository_id === entry.repository_id) entries[key] = { ...e, memory: false };
  }
  write({ ...data, entries });
}

/** Local data of a declared repository. */
export function repositoryDataDir(entry: { organization: OrganizationRef; repository_id: string }): string {
  return join(homedir(), ".kurtel", "knowledge", entry.organization.id, entry.repository_id);
}

function save(root: string, entry: AccessEntry): AccessEntry {
  const data = read();
  const key = folderKey(root), previous = data.entries[key];
  const next: AccessFile = { ...data, entries: { ...data.entries, [key]: entry } };
  // Access lost: the repository's local data is erased.
  const revoked = previous?.active && previous.organization && previous.repository_id && !entry.active && (entry.reason === "no_access" || entry.reason === "not_declared");
  if (revoked) {
    // Every other folder of the same repository stops too.
    for (const [other, e] of Object.entries(next.entries)) {
      if (other !== key && e.active && e.organization?.id === previous.organization!.id && e.repository_id === previous.repository_id) {
        next.entries[other] = { remote: e.remote, active: false, checked_at: entry.checked_at, reason: entry.reason, ...(e.chosen ? { chosen: e.chosen } : {}) };
      }
    }
    next.purge = [...new Set([...(data.purge ?? []), repositoryDataDir(previous as AccessEntry & { organization: OrganizationRef; repository_id: string })])];
  }
  write(next);
  purgePending();
  return entry;
}

/** Erases data of repositories whose access was lost; retried if a file is open. */
export function purgePending(): void {
  const data = read();
  if (!data.purge?.length) return;
  const stillUsed = new Set(Object.values(data.entries).filter(e => e.active && e.organization && e.repository_id).map(e => repositoryDataDir(e as AccessEntry & { organization: OrganizationRef; repository_id: string })));
  const left = data.purge.filter(dir => {
    if (stillUsed.has(dir)) return false; // access given back meanwhile
    try { rmSync(dir, { recursive: true, force: true }); return existsSync(dir); } catch { return true; }
  });
  if (left.length !== data.purge.length) write({ ...data, purge: left });
}

/** A refusal from the server: Kurtel stops here at once. */
export function denyAccess(root: string, reason: AccessReason, organizations?: OrganizationRef[]): void {
  const entry = accessEntry(root);
  if (!entry) return;
  save(root, { remote: entry.remote, active: false, checked_at: new Date().toISOString(), reason, ...(organizations?.length ? { organizations } : {}), ...(entry.chosen ? { chosen: entry.chosen } : {}) });
}

/** kurtel org use: the organization for this folder. */
export function chooseOrganization(root: string, organization: string): void {
  const remote = originRemote(root);
  if (!remote) throw new Error("This folder has no network origin remote");
  const entry = accessEntry(root);
  save(root, { ...(entry ?? { remote, active: false, checked_at: new Date(0).toISOString() }), chosen: organization });
}

/** Drops every kept answer (sign in or out). */
export function clearAccess(): void {
  const data = read();
  write({ version: 1, entries: {}, ...(data.purge?.length ? { purge: data.purge } : {}) });
}

/** Asks kurtel.io and keeps the answer. A network failure changes nothing. */
export async function checkAccess(root: string, options: { timeoutMs?: number } = {}): Promise<AccessEntry | null> {
  const remote = originRemote(root);
  if (!remote || !cloudAllowed()) return null;
  const previous = accessEntry(root);
  const token = loadConfig().token as string | undefined;
  const now = new Date().toISOString();
  const keep = previous?.chosen ? { chosen: previous.chosen } : {};
  if (!token) return save(root, { remote, active: false, checked_at: now, reason: "not_signed_in", ...keep });
  let response: Response;
  try {
    response = await policyFetch(`${apiUrl()}/api/cli/access`, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ remote, ...(previous?.chosen ? { organization: previous.chosen } : {}) }),
    }, "cloud");
  } catch { return previous; }
  if (response.status === 401) return save(root, { remote, active: false, checked_at: now, reason: "not_signed_in", ...keep });
  if (!response.ok) return previous;
  let body: Record<string, any>;
  try { body = await response.json() as Record<string, any>; } catch { return previous; }
  if (body.active === true && typeof body.repository_id === "string" && body.organization?.id) {
    return save(root, { remote, active: true, checked_at: now, organization: { id: body.organization.id, slug: body.organization.slug, name: body.organization.name }, repository_id: body.repository_id, role: body.role, memory: body.memory === true, ...keep });
  }
  if (body.active === false && typeof body.reason === "string") {
    return save(root, { remote, active: false, checked_at: now, reason: body.reason as AccessReason, ...(Array.isArray(body.organizations) ? { organizations: body.organizations } : {}), ...keep });
  }
  return previous;
}

/** Same, in a detached process. */
export function checkAccessInBackground(root: string): void {
  if (!originRemote(root) || !cloudAllowed()) return;
  try {
    const child = spawn(process.execPath, [process.argv[1], "access", "--quiet"], { cwd: root, env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
    child.on("error", () => {}); child.unref();
  } catch { /* Asked again at the next prompt. */ }
}
