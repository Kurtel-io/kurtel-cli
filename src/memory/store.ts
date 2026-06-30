import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Lance git directement (pas via cmd.exe) et SANS fenêtre console.
 * `windowsHide` évite le flash de terminal sous Windows quand l'appelant
 * (le watcher détaché) n'a pas de console attachée.
 */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).toString().trim();
}

// ── Types ──

/** Un pattern darwinien : une convention apprise des PR (merge/comments/close). */
export interface DarwinPattern {
  id: string;
  /** La règle, formulée pour un agent. Ex: "Stripe payments must use embedded checkout, never redirect." */
  rule: string;
  /** Zones du graphe où le pattern s'applique (préfixes de chemins ou noms de domaines). Vide = global. */
  zones: string[];
  /** Mots-clés d'intention qui activent le pattern ("stripe", "payment", "checkout"...). */
  triggers: string[];
  /** Score de fitness darwinien [0..1] — maintenu côté backend. */
  score: number;
  evidence: { pr: number; repo: string; kind: "born" | "confirmed" | "contradicted" }[];
  /** Pattern promu au socle: injecté quelle que soit l'intention. */
  pinned: boolean;
  updated_at: string;
}

/** Une route HTTP (ou handler) inventoriée — la réponse au pain point n°1. */
export interface RouteEntry {
  method: string;          // GET / POST / * (event handler, cron...)
  path: string;
  file: string;            // chemin relatif repo
  line: number;
  framework: string;       // express | fastapi | nest | flask | next | unknown
}

/** Une fonction/méthode définie dans un fichier, avec ses appels sortants. */
export interface SymbolNode {
  name: string;
  line: number;
  /** Appels résolus: "chemin/fichier.ts::fonction" (internes au repo). */
  calls: string[];
}

export interface ModuleNode {
  /** Chemin relatif du fichier. */
  id: string;
  exports: string[];
  imports: string[];       // ids des modules importés (résolus, internes au repo)
  loc: number;
  /** Degré entrant+sortant — proxy de centralité. */
  degree: number;
  /** Fonctions définies et leur graphe d'appels (borné). */
  symbols: SymbolNode[];
}

export interface CodebaseIndex {
  version: 1;
  /** Moteur d'extraction utilisé + nb de fichiers retombés en regex. */
  parser?: { engine: "tree-sitter" | "regex"; regex_fallbacks: number };
  repo: string;            // owner/name si détectable, sinon basename
  branch: string;          // branche git de l'index (défaut "main") — partitionne le graphe
  // PAS de `commit`/`generated_at` ici: ce fichier est versionné, ces champs changeaient à
  // chaque commit/reindex (churn git "juste un hash + une date") et cassaient le déterminisme
  // (deux machines, même code → fichiers différents). Le commit HEAD se calcule en live
  // (headCommit), l'âge de l'index = mtime du fichier (indexGeneratedAt). Aucun n'est load-bearing.
  files_indexed: number;
  routes: RouteEntry[];
  modules: ModuleNode[];
  /** Top modules par centralité — les "god nodes". */
  god_nodes: { id: string; degree: number }[];
  /** Domaines détectés: top-level dirs significatifs avec stats. */
  domains: { name: string; files: number; loc: number }[];
}

export interface MemoryCache {
  patterns: DarwinPattern[];
  patterns_synced_at: string | null;
  /** Dernier snapshot COMPLET (pas un delta). Sert à purger périodiquement les
   *  orphelins: un skill hard-deleté côté serveur (suppression UI, ou table
   *  vidée + ré-onboard) disparaît sans laisser de trace qu'un delta
   *  (`updated_at > since`) puisse capter → il faut un pull complet pour le retirer. */
  full_synced_at?: string | null;
  /** Télémétrie en attente d'envoi (fitness fin: usage des patterns). */
  pending_telemetry: TelemetryEvent[];
}

export interface TelemetryEvent {
  ts: string;
  session_id: string;
  repo: string;
  kind: "patterns_injected" | "duplicate_flagged" | "zone_entered";
  pattern_ids?: string[];
  detail?: string;
}

// ── Emplacements disque ──
//   ~/.kurtel/cache/<repo-slug>/  ← mémoire darwinienne + vecteurs (hors repo)
//   <repo>/.kurtel/               ← index.json, REPORT.md, state.json (dans le repo)

export function repoRoot(cwd = process.cwd()): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return cwd;
  }
}

export function repoSlug(root: string): string {
  let name = root.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  try {
    const url = git(["remote", "get-url", "origin"], root);
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) name = m[1];
  } catch { /* pas de remote */ }
  return name.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

/** Branche git courante. "main" par défaut (détaché / pas un repo git). */
export function currentBranch(root: string): string {
  try {
    const b = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    // HEAD détaché → "HEAD": on retombe sur main pour ne pas créer une branche fantôme.
    if (b && b !== "HEAD") return b;
  } catch { /* pas un repo git */ }
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

export function cacheDir(root: string): string {
  return join(homedir(), ".kurtel", "cache", repoSlug(root));
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}

function writeJSON(file: string, data: unknown): void {
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ── Cache mémoire darwinienne (par user × repo, hors du repo: ne se versionne pas) ──

const EMPTY_CACHE: MemoryCache = { patterns: [], patterns_synced_at: null, full_synced_at: null, pending_telemetry: [] };

/**
 * Dédoublonne des patterns par RÈGLE (contenu). Le delta sync fusionne par `id`,
 * or un même contenu peut vivre sous plusieurs `id`: un ré-onboard réécrit la table
 * avec de NOUVEAUX id, et les anciens — hard-deletés — ne sont jamais purgés par le
 * delta (un id absent du serveur n'apparaît pas dans `updated_at > since`). Sans
 * cette dédup, la capsule injecte la même règle deux fois → confiance détruite.
 * On garde un seul représentant par règle: épinglé d'abord, puis meilleur score,
 * puis le plus récemment mis à jour (= la génération vivante côté serveur).
 */
export function dedupePatterns(patterns: DarwinPattern[]): DarwinPattern[] {
  const better = (a: DarwinPattern, b: DarwinPattern): boolean => {
    if (!!a.pinned !== !!b.pinned) return !!a.pinned;
    if (a.score !== b.score) return a.score > b.score;
    return (a.updated_at ?? "") > (b.updated_at ?? "");
  };
  const best = new Map<string, DarwinPattern>();
  for (const p of patterns) {
    const key = p.rule.trim();
    const cur = best.get(key);
    if (!cur || better(p, cur)) best.set(key, p);
  }
  return [...best.values()];
}

export function loadMemoryCache(root: string): MemoryCache {
  return readJSON(join(cacheDir(root), "memory.json"), EMPTY_CACHE);
}

export function saveMemoryCache(root: string, cache: MemoryCache): void {
  writeJSON(join(cacheDir(root), "memory.json"), cache);
}

export function queueTelemetry(root: string, ev: TelemetryEvent): void {
  const cache = loadMemoryCache(root);
  cache.pending_telemetry.push(ev);
  // borne dure: pas de croissance infinie
  if (cache.pending_telemetry.length > 500) {
    cache.pending_telemetry = cache.pending_telemetry.slice(-500);
  }
  saveMemoryCache(root, cache);
}

// ── Index de codebase (dans le repo: partageable, déterministe) ──

export function indexPath(root: string): string {
  return join(root, ".kurtel", "index.json");
}

export function reportPath(root: string): string {
  return join(root, ".kurtel", "REPORT.md");
}

/** HEAD court — calculé en live, jamais persisté (sinon churn). "unknown" hors repo git. */
export function headCommit(root: string): string {
  try {
    const sha = git(["rev-parse", "HEAD"], root);
    if (sha) return sha;
  } catch { /* pas un repo git */ }
  return "unknown";
}

/** Date de dernière (re)génération de l'index = mtime du fichier. null si absent.
 *  Remplace l'ancien champ `generated_at` persisté (qui polluait le fichier versionné). */
export function indexGeneratedAt(root: string): string | null {
  try {
    return statSync(indexPath(root)).mtime.toISOString();
  } catch {
    return null;
  }
}

// ── Journal d'injection (dans le repo, gitignoré: ce que la mémoire a injecté) ──
//   <repo>/.kurtel/injection-log.md  ← append-only, lisible, rotation O(1) par renommage.
//   But: l'utilisateur ouvre ce fichier et voit, prompt par prompt, le texte exact
//   ajouté au contexte de l'agent. Tout est déjà calculé localement par le hook → un
//   simple append (sub-ms). Le hook est un process court: 1 stat + 1 append par prompt.

export function injectionLogPath(root: string): string {
  return join(root, ".kurtel", "injection-log.md");
}

const INJECTION_LOG_MAX_BYTES = 1_500_000; // ~1.5 Mo → rotation (on garde 1 génération précédente)

/** Garantit que le journal est ignoré par git, même si `.kurtel/` ne l'est pas déjà.
 *  Scopé aux fichiers du journal: ne touche pas index.json/REPORT.md (que l'utilisateur
 *  peut vouloir versionner). Idempotent, best-effort. */
function ensureInjectionLogIgnored(root: string): void {
  const gi = join(root, ".kurtel", ".gitignore");
  try {
    const want = ["injection-log.md", "injection-log.old.md", "injected.jsonl"];
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
    const missing = want.filter((w) => !have.has(w));
    if (!missing.length) return;
    const header = cur ? "" : "# Kurtel local injection journal — machine-specific, never commit\n";
    appendFileSync(gi, header + missing.join("\n") + "\n", "utf8");
  } catch { /* best-effort: jamais bloquant */ }
}

/** Append une entrée pré-formatée au journal. JAMAIS d'erreur visible (un journal
 *  qui casse ne doit pas casser l'injection). Rotation par renommage (zéro read sur
 *  le hot path). Désactivable via `KURTEL_NO_INJECTION_LOG`. */
export function appendInjectionLog(root: string, entry: string): void {
  if (process.env.KURTEL_NO_INJECTION_LOG) return;
  try {
    const file = injectionLogPath(root);
    const dir = join(file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) ensureInjectionLogIgnored(root); // une seule fois, à la création
    try {
      if (statSync(file).size > INJECTION_LOG_MAX_BYTES) {
        const old = file.replace(/\.md$/, ".old.md");
        try { rmSync(old); } catch { /* pas d'ancienne génération */ } // Windows: rename échoue si la cible existe
        renameSync(file, old);
      }
    } catch { /* fichier absent = premier write */ }
    appendFileSync(file, entry, "utf8");
  } catch { /* le journal ne doit jamais casser l'injection */ }
}

/** Tail du journal (les derniers `maxBytes` octets). null si vide/absent. */
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

/** Vide le journal (et sa génération précédente + le sidecar d'ids). */
export function clearInjectionLog(root: string): void {
  for (const f of [
    injectionLogPath(root),
    injectionLogPath(root).replace(/\.md$/, ".old.md"),
    injectedIdsPath(root),
  ]) {
    try { rmSync(f); } catch { /* déjà absent */ }
  }
}

// ── Sidecar structuré des ids injectés (machine-readable, ≠ journal markdown) ──
//   <repo>/.kurtel/injected.jsonl  ← une ligne {t, ids} par prompt injecté.
//   But: corréler "règle injectée à l'agent" ↔ "règle violée par le commit qui suit"
//   (signal négatif en OR "injected-then-violated"). Le markdown est pour l'humain;
//   ce sidecar est pour la machine (parsing fiable, pas de regex sur du markdown).

export function injectedIdsPath(root: string): string {
  return join(root, ".kurtel", "injected.jsonl");
}

const INJECTED_MAX_BYTES = 200_000; // au-delà, on retaille à la fin (best-effort)
const INJECTED_KEEP_LINES = 500;

/** Append {t, ids} pour un prompt. Best-effort, jamais bloquant, gitignoré. */
export function appendInjectedIds(root: string, ids: string[]): void {
  if (!ids.length || process.env.KURTEL_NO_INJECTION_LOG) return;
  try {
    const file = injectedIdsPath(root);
    const dir = join(file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) ensureInjectionLogIgnored(root); // couvre injected.jsonl
    // Retaille seulement quand le fichier grossit (pas de read sur le hot path normal).
    try {
      if (statSync(file).size > INJECTED_MAX_BYTES) {
        const kept = readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-INJECTED_KEEP_LINES);
        writeFileSync(file, kept.join("\n") + "\n", "utf8");
      }
    } catch { /* fichier absent = premier write */ }
    appendFileSync(file, JSON.stringify({ t: Date.now(), ids }) + "\n", "utf8");
  } catch { /* le sidecar ne doit jamais casser l'injection */ }
}

/** Union des ids injectés depuis `sinceMs` (au plus `limit` dernières entrées). */
export function readRecentInjectedIds(root: string, sinceMs: number, limit = 200): string[] {
  try {
    const file = injectedIdsPath(root);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-limit);
    const out = new Set<string>();
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as { t?: number; ids?: unknown };
        if (typeof o.t === "number" && o.t >= sinceMs && Array.isArray(o.ids)) {
          for (const id of o.ids) if (typeof id === "string") out.add(id);
        }
      } catch { /* ligne corrompue: ignorée */ }
    }
    return [...out];
  } catch {
    return [];
  }
}

// ── Embeddings sémantiques ──
//   ~/.kurtel/vectors/{vectors.bin,vocab.txt}     ← table alignée, partagée entre repos
//   ~/.kurtel/cache/<slug>/embeddings.{bin,json}  ← un vecteur par module (par repo)

export function vectorsPathsIn(dir: string): { bin: string; vocab: string } {
  return { bin: join(dir, "vectors.bin"), vocab: join(dir, "vocab.txt") };
}

/** Override par l'utilisateur (import manuel / air-gapped) — prioritaire sur la table bundlée. */
export function userVectorsDir(): string {
  return join(homedir(), ".kurtel", "vectors");
}

/** Table livrée avec le package: dist|src/memory → ../../assets/vectors (même chemin en build et en dev tsx). */
function bundledVectorsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "vectors");
}

/** Chemins de LECTURE: override utilisateur si présent, sinon la table bundlée. */
export function vectorsReadPaths(): { bin: string; vocab: string } {
  const user = vectorsPathsIn(userVectorsDir());
  if (existsSync(user.bin) && existsSync(user.vocab)) return user;
  return vectorsPathsIn(bundledVectorsDir());
}

function embeddingsPaths(root: string): { bin: string; meta: string } {
  const d = cacheDir(root);
  return { bin: join(d, "embeddings.bin"), meta: join(d, "embeddings.json") };
}

export function saveModuleVectors(root: string, mv: { dim: number; ids: string[]; matrix: Float32Array }): void {
  const { bin, meta } = embeddingsPaths(root);
  const dir = join(bin, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(mv.matrix.length * 4);
  for (let i = 0; i < mv.matrix.length; i++) buf.writeFloatLE(mv.matrix[i], i * 4);
  writeFileSync(bin, buf);
  writeFileSync(meta, JSON.stringify({ dim: mv.dim, ids: mv.ids }) + "\n", "utf8");
}

let mvCache: { root: string; map: Map<string, Float32Array> } | null = null;

/** Map id → vecteur. Caché pour ce process (le hook est court-vécu: un chargement). */
export function loadModuleVectors(root: string): Map<string, Float32Array> | null {
  if (mvCache && mvCache.root === root) return mvCache.map;
  const { bin, meta } = embeddingsPaths(root);
  if (!existsSync(bin) || !existsSync(meta)) return null;
  try {
    const { dim, ids } = JSON.parse(readFileSync(meta, "utf8")) as { dim: number; ids: string[] };
    const buf = readFileSync(bin);
    const floats = new Float32Array(dim * ids.length);
    for (let i = 0; i < floats.length; i++) floats[i] = buf.readFloatLE(i * 4);
    const map = new Map<string, Float32Array>();
    for (let r = 0; r < ids.length; r++) map.set(ids[r], floats.subarray(r * dim, (r + 1) * dim));
    mvCache = { root, map };
    return map;
  } catch {
    return null;
  }
}

export function loadIndex(root: string): CodebaseIndex | null {
  const file = indexPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CodebaseIndex;
  } catch {
    return null;
  }
}

export function saveIndex(root: string, index: CodebaseIndex): void {
  writeJSON(indexPath(root), index);
}

// ── État local de la mémoire (on/off + zones vues par session) ──

interface MemoryState {
  enabled: boolean;
  /** session_id -> zones (top-level dirs) déjà couvertes par une capsule. */
  session_zones: Record<string, string[]>;
}

const EMPTY_STATE: MemoryState = { enabled: true, session_zones: {} };

function statePath(root: string): string {
  return join(cacheDir(root), "state.json");
}

export function loadMemoryState(root: string): MemoryState {
  return readJSON(statePath(root), EMPTY_STATE);
}

export function saveMemoryState(root: string, state: MemoryState): void {
  // garde-fou: borne le nombre de sessions retenues
  const ids = Object.keys(state.session_zones);
  if (ids.length > 20) {
    for (const id of ids.slice(0, ids.length - 20)) delete state.session_zones[id];
  }
  writeJSON(statePath(root), state);
}

export function memoryEnabled(root: string): boolean {
  return loadMemoryState(root).enabled;
}

export function setMemoryEnabled(root: string, enabled: boolean): void {
  const s = loadMemoryState(root);
  s.enabled = enabled;
  saveMemoryState(root, s);
}
