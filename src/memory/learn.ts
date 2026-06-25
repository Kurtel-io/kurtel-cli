import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { cacheDir, repoFullName, memoryEnabled, readRecentInjectedIds } from "./store.js";
import { postLearnEvent } from "./api.js";

// ── Apprentissage local: chaque commit du dev est un signal d'acceptation ─────
// On ne touche JAMAIS au working tree ni à git: lecture seule. Tout est best
// effort et silencieux — un échec ici ne doit jamais gêner le développeur.
// Les vraies gardes anti-bruit (graduation, fitness) vivent côté backend; ici on
// se contente de filtrer le gros bruit avant même d'émettre un appel réseau.

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cs"];
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|go\.sum|Cargo\.lock)$|(^|\/)(dist|build|out|node_modules|vendor|__pycache__)\//;

const MAX_DIFF = 8000;
const MIN_CHANGED_LINES = 2; // sous ce seuil (lignes réelles, hors whitespace) = trivial
const MAX_FILES = 60;        // au-delà c'est probablement généré/bulk — on ignore

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }).toString();
}

/** Lignes réellement modifiées dans un patch (les +/- de contenu, hors en-têtes +++/---). */
function countChangedLines(patch: string): number {
  let n = 0;
  for (const line of patch.split("\n")) {
    if ((line[0] === "+" || line[0] === "-") && !line.startsWith("+++") && !line.startsWith("---")) n++;
  }
  return n;
}

// ── Troncature consciente du diff ─────────────────────────────────────────────
// On ne coupe JAMAIS au milieu d'un hunk (sinon le LLM voit du code amputé et peut
// en tirer une fausse règle). On garde des hunks/fichiers entiers tant qu'il reste
// du budget, puis on colle un marqueur [TRUNCATED] que le prompt de distillation
// sait interpréter — pour qu'il ne conclue pas que le code est incomplet/cassé.

const TRUNC_BUDGET_RESERVE = 320; // place réservée au marqueur

/** Découpe un diff en blocs entiers (en-tête de fichier `diff --git`, ou hunk `@@`). */
function splitDiffBlocks(diff: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of diff.split("\n")) {
    if ((line.startsWith("diff --git") || line.startsWith("@@")) && cur.length) {
      blocks.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

function truncateDiff(diff: string, budget: number): string {
  if (diff.length <= budget) return diff;
  const room = budget - TRUNC_BUDGET_RESERVE;
  const out: string[] = [];
  let len = 0, hunks = 0, kept = 0, stopped = false;
  for (const b of splitDiffBlocks(diff)) {
    const isHunk = b.startsWith("@@");
    if (isHunk) hunks++;
    if (stopped) continue;             // on garde un préfixe CONTIGU de blocs entiers
    if (len + b.length + 1 <= room) { out.push(b); len += b.length + 1; if (isHunk) kept++; }
    else stopped = true;
  }
  const omitted = hunks - kept;
  return (
    out.join("\n") +
    `\n\n[TRUNCATED] This diff was cut to fit a size budget — ${omitted} hunk(s) omitted. ` +
    `The code shown is incomplete; do NOT infer that anything is missing, broken, or that the ` +
    `omission is meaningful. Base any skill ONLY on the changes fully visible above.`
  );
}

function headSha(root: string): string | null {
  try {
    const s = git(root, ["rev-parse", "HEAD"]).trim();
    return s || null;
  } catch {
    return null;
  }
}

/** Empreinte de contenu d'un patch: hash des lignes +/- de contenu uniquement.
 * Stable à travers amend/cherry-pick/rebase (même changement → même empreinte),
 * indépendante du SHA. Sert au dedup côté backend pour ne pas gonfler les observations. */
function changeFingerprint(patch: string): string {
  const h = createHash("sha1");
  for (const line of patch.split("\n")) {
    if ((line[0] === "+" || line[0] === "-") && !line.startsWith("+++") && !line.startsWith("---")) {
      h.update(line + "\n");
    }
  }
  return h.digest("hex");
}

/** True si un rebase/merge/cherry-pick/revert/bisect est en cours: on n'apprend pas
 * (git ne déclenche de toute façon pas post-commit pendant un rebase; ceci protège
 * le filet du daemon, qui lui verrait défiler les SHA réécrits). */
function specialGitStateInProgress(root: string): boolean {
  let gitDir = "";
  try { gitDir = git(root, ["rev-parse", "--git-dir"]).trim(); } catch { return false; }
  if (!gitDir) return false;
  const base = isAbsolute(gitDir) ? gitDir : join(root, gitDir);
  return [
    "rebase-merge", "rebase-apply",
    "CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "BISECT_LOG",
  ].some((m) => existsSync(join(base, m)));
}

// ── Marqueur "dernier commit appris" (par repo, hors du repo) ──────────────────
function markerPath(root: string): string {
  return join(cacheDir(root), "learn-state.json");
}
function lastLearnedSha(root: string): string | null {
  try {
    return JSON.parse(readFileSync(markerPath(root), "utf8")).last_sha ?? null;
  } catch {
    return null;
  }
}
function saveLastLearnedSha(root: string, sha: string): void {
  try {
    const dir = cacheDir(root);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(root), JSON.stringify({ last_sha: sha }) + "\n");
  } catch { /* best effort */ }
}

/** Lignes "kurtel: <règle>" du message → règles explicites (confiance max côté backend). */
function parseInlineRules(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split("\n")) {
    const m = line.match(/^\s*kurtel:\s*(.+?)\s*$/i);
    if (m && m[1].length >= 6) out.push(m[1]);
  }
  return out.slice(0, 6);
}

interface Commit {
  sha: string;
  message: string;
  diff: string;
  rules: string[];
  changeFp: string;
}

/** Lit un commit et applique les gardes locales. Retourne null s'il doit être ignoré. */
function collectCommit(root: string, sha: string): Commit | null {
  let parents: string;
  try { parents = git(root, ["show", "-s", "--format=%P", sha]).trim(); }
  catch { return null; }
  if (parents.split(/\s+/).filter(Boolean).length > 1) return null; // merge commit

  // N'apprendre que des commits écrits PAR le dev local (pas d'un git pull).
  let author = "", me = "";
  try { author = git(root, ["show", "-s", "--format=%ae", sha]).trim().toLowerCase(); } catch { return null; }
  try { me = git(root, ["config", "user.email"]).trim().toLowerCase(); } catch { /* */ }
  if (!author || !me || author !== me) return null;

  const message = (() => { try { return git(root, ["show", "-s", "--format=%B", sha]).trim(); } catch { return ""; } })();

  // Fichiers de code touchés (ajoutés/copiés/modifiés/renommés), hors bruit.
  let files: string[];
  try {
    files = git(root, ["show", "--name-only", "--format=", "--diff-filter=ACMR", sha])
      .split("\n").map((s) => s.trim()).filter(Boolean)
      .filter((f) => CODE_EXT.some((e) => f.endsWith(e)) && !NOISE.test(f));
  } catch { return null; }
  if (!files.length || files.length > MAX_FILES) return null;

  let diff = "";
  try { diff = git(root, ["show", "--format=", "--unified=3", sha, "--", ...files]); }
  catch { return null; }

  // Triviality jugée sur les lignes RÉELLEMENT changées, whitespace ignoré (-w):
  // un commit de pur reformatage (prettier, réindentation) tombe à 0 → ignoré.
  // Le diff -w sert aussi d'empreinte de contenu (stable à travers amend/rebase).
  let diffW = "";
  try { diffW = git(root, ["show", "-w", "--format=", "--unified=0", sha, "--", ...files]); }
  catch { diffW = diff; } // fallback si -w échoue
  if (countChangedLines(diffW) < MIN_CHANGED_LINES) return null;

  diff = truncateDiff(diff, MAX_DIFF); // coupe aux frontières de hunk + marqueur [TRUNCATED]
  return { sha, message, diff, rules: parseInlineRules(message), changeFp: changeFingerprint(diffW) };
}

/**
 * Détecte un nouveau commit HEAD et l'apprend. Idempotent, single-flight implicite
 * (le marqueur évite de retraiter), silencieux. Appelé par le watcher.
 */
let inFlight = false;
export async function learnFromCommit(root: string): Promise<void> {
  if (inFlight) return;
  if (!memoryEnabled(root)) return;
  // Pendant un rebase/cherry-pick: ne pas apprendre (SHA réécrits = faux votes).
  // On NE marque pas le SHA courant → le tip final sera appris une fois l'opération finie.
  if (specialGitStateInProgress(root)) return;

  const sha = headSha(root);
  if (!sha || sha === lastLearnedSha(root)) return;

  inFlight = true;
  try {
    const commit = collectCommit(root, sha);
    if (!commit) { saveLastLearnedSha(root, sha); return; } // gardé: pas la peine de réessayer

    // Ids des skills injectés DEPUIS le commit parent = les règles que l'agent avait
    // sous les yeux en produisant ce commit. Si le commit en viole une, c'est le
    // signal négatif le plus fort (cf. recordViolation backend).
    const parentMs = (() => {
      try { return parseInt(git(root, ["show", "-s", "--format=%ct", `${sha}^`]).trim(), 10) * 1000; }
      catch { return 0; } // commit initial (pas de parent) → toute la fenêtre disponible
    })();
    const injectedIds = readRecentInjectedIds(root, Number.isFinite(parentMs) ? parentMs : 0);

    try {
      await postLearnEvent(repoFullName(root), {
        source: "commit",
        commit_sha: commit.sha,
        change_fp: commit.changeFp,
        message: commit.message,
        diff: commit.diff,
        rules: commit.rules,
        injected_ids: injectedIds.length ? injectedIds : undefined,
      });
      saveLastLearnedSha(root, sha);
    } catch {
      // réseau down: on NE marque pas → on réessaiera au prochain tick (le backend dédoublonne).
    }
  } finally {
    inFlight = false;
  }
}
