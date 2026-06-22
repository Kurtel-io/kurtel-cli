import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// ── Hook git post-commit: apprentissage à CHAQUE commit, quel que soit l'outil ─
// C'est la garantie de couverture: indépendant de Claude Code/Codex/aucun agent,
// indépendant du daemon. git ne déclenche PAS post-commit pendant un rebase (les
// commits rejoués passent par post-rewrite), donc pas de tempête de rebase ici.
// Le hook est non-bloquant: il lance `kurtel learn-commit` détaché et rend la main.

const MARKER_START = "# >>> kurtel auto-learn (do not edit) >>>";
const MARKER_END = "# <<< kurtel auto-learn <<<";

const BLOCK = [
  MARKER_START,
  // fire-and-forget: ne jamais retarder le terminal du dev. No-op si kurtel absent du PATH.
  "command -v kurtel >/dev/null 2>&1 && (kurtel learn-commit >/dev/null 2>&1 &)",
  MARKER_END,
].join("\n");

function gitOut(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      .toString().trim() || null;
  } catch {
    return null;
  }
}

/** Répertoire où git cherche RÉELLEMENT les hooks, en respectant core.hooksPath et les worktrees. */
function hooksDir(root: string): string | null {
  // 1. core.hooksPath a la priorité absolue: si défini (husky, configs custom),
  //    git ne regarde QUE là — installer ailleurs serait inutile.
  const cfg = gitOut(root, ["config", "--get", "core.hooksPath"]);
  if (cfg) return isAbsolute(cfg) ? cfg : join(root, cfg);

  // 2. Défaut: <git-dir>/hooks (--git-path gère aussi les worktrees).
  const p = gitOut(root, ["rev-parse", "--git-path", "hooks"]);
  if (p) return isAbsolute(p) ? p : join(root, p);

  return null;
}

/** Installe (ou met à jour) le hook post-commit. Append-safe et idempotent. */
export function installCommitHook(root: string): boolean {
  const dir = hooksDir(root);
  if (!dir) return false;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, "post-commit");

    if (existsSync(file)) {
      const cur = readFileSync(file, "utf8");
      if (cur.includes(MARKER_START)) return true; // déjà à jour
      // Hook existant (husky, etc.): on AJOUTE notre bloc sans toucher au reste.
      const sep = cur.endsWith("\n") ? "" : "\n";
      writeFileSync(file, cur + sep + "\n" + BLOCK + "\n");
    } else {
      writeFileSync(file, "#!/bin/sh\n" + BLOCK + "\n");
    }
    try { chmodSync(file, 0o755); } catch { /* Windows: sans effet, git lance le hook via sh */ }
    return true;
  } catch {
    return false;
  }
}

/** Retire notre bloc du hook post-commit, en laissant intact tout hook tiers. */
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
    // S'il ne reste que le shebang (notre bloc était seul), on supprime le fichier.
    if (cleaned.trim() === "#!/bin/sh" || cleaned.trim() === "") {
      writeFileSync(file, ""); // vidé; git ignore un hook vide
    } else {
      writeFileSync(file, cleaned);
    }
  } catch { /* best effort */ }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
