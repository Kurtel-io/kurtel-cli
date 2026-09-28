import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).toString().trim();
}

export function repoRoot(cwd = process.cwd()): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return cwd;
  }
}

export function isGitRepo(cwd = process.cwd()): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

// Cached per process.
const slugs = new Map<string, string>();
export function repoSlug(root: string): string {
  const known = slugs.get(root);
  if (known) return known;
  const slug = computeRepoSlug(root);
  slugs.set(root, slug);
  return slug;
}

function computeRepoSlug(root: string): string {
  let name = root.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  try {
    const url = git(["remote", "get-url", "origin"], root);
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) name = m[1];
  } catch { /* no remote */ }
  return name.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

/** HEAD read from .git directly; null when the layout is not plain (callers then ask Git). */
function readHead(root: string): { branch: string | null; commit: string | null } | null {
  try {
    const dir = join(root, ".git");
    if (!statSync(dir).isDirectory()) return null;
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return { branch: null, commit: head };
    const ref = /^ref: (refs\/heads\/.+)$/.exec(head)?.[1];
    if (!ref) return null;
    let commit: string | null = null;
    try { commit = readFileSync(join(dir, ...ref.split("/")), "utf8").trim(); } catch { return null; }
    return /^[0-9a-f]{40,64}$/.test(commit) ? { branch: ref.slice("refs/heads/".length), commit } : null;
  } catch { return null; }
}

export function currentBranch(root: string): string {
  const head = readHead(root);
  if (head) return head.branch ?? "main";
  try {
    const b = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    // Detached HEAD: main.
    if (b && b !== "HEAD") return b;
  } catch { /* not a Git repository */ }
  return "main";
}

export function repoFullName(root: string): string {
  try {
    const url = git(["remote", "get-url", "origin"], root);
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git?)?$/);
    if (m) return m[1].replace(/\.git$/, "");
  } catch { /* ignore */ }
  return root.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
}

export function headCommit(root: string): string {
  const head = readHead(root);
  if (head?.commit) return head.commit;
  try {
    const sha = git(["rev-parse", "HEAD"], root);
    if (sha) return sha;
  } catch { /* not a Git repository */ }
  return "unknown";
}

/** Whether `commit` is in HEAD's history (false when unknown here). */
export function isAncestor(root: string, commit: string): boolean {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) return false;
  try { git(["merge-base", "--is-ancestor", commit, "HEAD"], root); return true; } catch { return false; }
}

/** Committer date of HEAD, or null. */
export function headCommitTime(root: string): string | null {
  try { return git(["log", "-1", "--format=%cI", "HEAD"], root) || null; } catch { return null; }
}

/** Whether these paths (or the whole tree) have uncommitted changes. */
export function hasUncommittedChanges(root: string, paths: string[] = []): boolean {
  try { return git(["status", "--porcelain", "--untracked-files=no", ...(paths.length ? ["--", ...paths] : [])], root).length > 0; } catch { return true; }
}
