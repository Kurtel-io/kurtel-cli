import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Earlier versions installed a post-commit hook. This removes Kurtel's block only, leaving other hooks untouched.
const MARKER_START = "# >>> kurtel auto-learn (do not edit) >>>";
const MARKER_END = "# <<< kurtel auto-learn <<<";

function gitOut(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      .toString().trim() || null;
  } catch {
    return null;
  }
}

/** The directory Git actually reads hooks from, honouring core.hooksPath and worktrees. */
function hooksDir(root: string): string | null {
  // 1. core.hooksPath wins: when set (husky, custom setups) Git looks nowhere else.
  const cfg = gitOut(root, ["config", "--get", "core.hooksPath"]);
  if (cfg) return isAbsolute(cfg) ? cfg : join(root, cfg);

  // 2. Default: <git-dir>/hooks (--git-path also handles worktrees).
  const p = gitOut(root, ["rev-parse", "--git-path", "hooks"]);
  if (p) return isAbsolute(p) ? p : join(root, p);

  return null;
}

/** Removes Kurtel's block from the post-commit hook, leaving any other hook intact. */
export function uninstallCommitHook(root: string): void {
  const dir = hooksDir(root);
  if (!dir) return;
  try {
    const file = join(dir, "post-commit");
    if (!existsSync(file)) return;
    const cur = readFileSync(file, "utf8");
    if (!cur.includes(MARKER_START)) return;
    const cleaned = cur
      .replace(new RegExp(`\\n*${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}\\n*`, "g"), "\n")
      .replace(/\n{3,}/g, "\n\n");
    // Only the shebang left (Kurtel's block was alone): delete the file.
    if (cleaned.trim() === "#!/bin/sh" || cleaned.trim() === "") {
      unlinkSync(file);
    } else {
      writeFileSync(file, cleaned);
    }
  } catch { /* best effort */ }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
