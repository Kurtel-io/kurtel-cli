import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Types — le contrat de données partagé entre le CLI, les hooks et le backend.
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Provenance: PRs qui ont fait naître/confirmé le pattern. */
  evidence: { pr: number; repo: string; kind: "born" | "confirmed" | "contradicted" }[];
  /** Pattern promu au socle: injecté quelle que soit l'intention. */
  pinned: boolean;
  updated_at: string;
}

/** Une route HTTP (ou handler) inventoriée — la réponse au pain point n°1. */
export interface RouteEntry {
  method: string;          // GET / POST / * (event handler, cron...)
  path: string;            // /clients/:id/invoices
  file: string;            // chemin relatif repo
  line: number;
  framework: string;       // express | fastapi | nest | flask | next | unknown
}

export interface ModuleNode {
  /** Chemin relatif du fichier. */
  id: string;
  exports: string[];
  imports: string[];       // ids des modules importés (résolus, internes au repo)
  loc: number;
  /** Degré entrant+sortant — proxy de centralité. */
  degree: number;
}

export interface CodebaseIndex {
  version: 1;
  repo: string;            // owner/name si détectable, sinon basename
  commit: string;          // HEAD au moment de l'index
  generated_at: string;
  files_indexed: number;
  routes: RouteEntry[];
  modules: ModuleNode[];
  /** Top modules par centralité — les "god nodes". */
  god_nodes: { id: string; degree: number }[];
  /** Domaines détectés: top-level dirs significatifs avec stats. */
  domains: { name: string; files: number; loc: number }[];
}

/** Cache local complet pour un repo. */
export interface MemoryCache {
  patterns: DarwinPattern[];
  patterns_synced_at: string | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Emplacements disque
//   ~/.kurtel/cache/<repo-slug>/patterns.json   ← mémoire darwinienne (pull Supabase)
//   <repo>/.kurtel/index.json                   ← mémoire de codebase (déterministe)
//   <repo>/.kurtel/REPORT.md                    ← rapport d'audit lisible
//   <repo>/.kurtel/memory.json                  ← état local (on/off, session zones)
// ─────────────────────────────────────────────────────────────────────────────

export function repoRoot(cwd = process.cwd()): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return cwd;
  }
}

export function repoSlug(root: string): string {
  // owner/name depuis le remote si possible, sinon basename — slugifié pour un nom de dossier.
  let name = root.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  try {
    const url = execSync("git remote get-url origin", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) name = m[1];
  } catch { /* pas de remote */ }
  return name.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

export function repoFullName(root: string): string {
  try {
    const url = execSync("git remote get-url origin", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git?)?$/);
    if (m) return m[1].replace(/\.git$/, "");
  } catch { /* ignore */ }
  return root.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
}

function cacheDir(root: string): string {
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

const EMPTY_CACHE: MemoryCache = { patterns: [], patterns_synced_at: null, pending_telemetry: [] };

export function loadMemoryCache(root: string): MemoryCache {
  return readJSON(join(cacheDir(root), "memory.json"), EMPTY_CACHE);
}

export function saveMemoryCache(root: string, cache: MemoryCache): void {
  writeJSON(join(cacheDir(root), "memory.json"), cache);
}

export function queueTelemetry(root: string, ev: TelemetryEvent): void {
  const cache = loadMemoryCache(root);
  cache.pending_telemetry.push(ev);
  // borne dure: jamais plus de 500 événements en attente (pas de croissance infinie)
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
  // garde-fou: ne garder que les 20 dernières sessions
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
