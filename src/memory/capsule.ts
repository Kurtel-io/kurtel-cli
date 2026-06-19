import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseIndex, DarwinPattern, RouteEntry } from "./store.js";
import { findSimilarRoutes } from "./indexer.js";
import { embeddingsAvailable, embedTokens, cosine } from "./embed.js";
import { loadModuleVectors } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Capsule — le cœur du produit. À chaque prompt:
//   intention → résolution spatiale (zones du graphe) → sélection de patterns
//   → capsule compacte (budget ~400 tokens) injectée via le hook.
// Tout se calcule en local, en millisecondes, sans réseau.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_BUDGET_CHARS = 1600; // ~400 tokens
const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "in", "on", "and", "or", "with", "add",
  "create", "make", "fix", "update", "change", "new", "page", "file", "please",
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "pour", "dans",
  "ajoute", "ajouter", "crée", "creer", "modifie", "modifier", "corrige", "il", "faut",
]);

export function tokenize(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )];
}

// ── Contexte sémantique (optionnel): vecteur de requête + vecteurs modules ──
//   Construit une fois par capsule. Absent si pas de table → tout retombe lexical.

export interface SemanticContext {
  q: Float32Array | null;                  // vecteur du prompt (FR)
  mvec: Map<string, Float32Array> | null;  // id module → vecteur (code EN)
}

// Le cosinus ne compte qu'au-dessus d'un plancher (sinon tous les modules fuient
// un peu de signal). Au-dessus, il pèse comme ~2-3 hits lexicaux sur un fort match.
const SEM_FLOOR = 0.30;
const SEM_WEIGHT_ZONE = 8;
const SEM_WEIGHT_ROUTE = 4;

function semScore(sem: SemanticContext | undefined, id: string, weight: number): number {
  if (!sem?.q || !sem.mvec) return 0;
  const v = sem.mvec.get(id);
  if (!v) return 0;
  const cs = cosine(sem.q, v);
  return cs > SEM_FLOOR ? (cs - SEM_FLOOR) * weight : 0;
}

// ── Résolution spatiale: quelles zones du repo l'intention touche-t-elle ? ──

export function resolveZones(index: CodebaseIndex, promptTokens: string[], sem?: SemanticContext): string[] {
  // Score de zone = MAX du score de ses modules (pas la somme): une zone vaut son
  // meilleur fichier, sinon les gros dossiers gagnent par accumulation (biais de taille).
  // Léger tie-break par le 2e meilleur, pour départager deux zones dont le top est à égalité.
  const best = new Map<string, number>();
  const second = new Map<string, number>();
  for (const m of index.modules) {
    const hay = m.id.toLowerCase();
    let s = 0;
    for (const t of promptTokens) if (hay.includes(t)) s += 2;
    for (const e of m.exports) {
      const el = e.toLowerCase();
      for (const t of promptTokens) if (el.includes(t)) s += 1;
    }
    s += semScore(sem, m.id, SEM_WEIGHT_ZONE); // pont FR→EN: surfacé même sans match lexical
    if (s <= 0) continue;
    const zone = m.id.includes("/") ? m.id.split("/").slice(0, 2).join("/") : m.id;
    const b = best.get(zone) ?? 0;
    if (s > b) { second.set(zone, b); best.set(zone, s); }
    else if (s > (second.get(zone) ?? 0)) second.set(zone, s);
  }
  return [...best.entries()]
    .map(([z, b]) => [z, b + 0.1 * (second.get(z) ?? 0)] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([z]) => z);
}

// ── Sélection darwinienne: les patterns pertinents pour CETTE tâche ─────────

export interface SelectedPattern { pattern: DarwinPattern; score: number }

export function selectPatterns(
  patterns: DarwinPattern[],
  promptTokens: string[],
  zones: string[],
  max = 5
): SelectedPattern[] {
  const out: SelectedPattern[] = [];
  for (const p of patterns) {
    if (p.score < 0.3 && !p.pinned) continue; // les mourants ne parlent plus
    let s = 0;
    if (p.pinned) s += 10; // socle: toujours présent
    for (const trig of p.triggers) {
      const tl = trig.toLowerCase();
      if (promptTokens.some((t) => t === tl || tl.includes(t) || t.includes(tl))) s += 4;
    }
    for (const z of p.zones) {
      if (zones.some((zone) => zone.startsWith(z) || z.startsWith(zone))) s += 3;
    }
    if (p.zones.length === 0 && s > 0) s += 1; // global + déjà pertinent
    if (s > 0) out.push({ pattern: p, score: s * (0.5 + p.score) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

// ── Routes pertinentes pour l'intention (anti-duplication proactive) ────────

export function relevantRoutes(index: CodebaseIndex, promptTokens: string[], sem?: SemanticContext): RouteEntry[] {
  const scored = index.routes.map((r) => {
    const hay = `${r.path} ${r.file}`.toLowerCase();
    let s = 0;
    for (const t of promptTokens) if (hay.includes(t)) s++;
    s += semScore(sem, r.file, SEM_WEIGHT_ROUTE); // proximité sémantique via le module qui définit la route
    return { r, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.r);
}

// ── Cibles de réutilisation: fonctions exportées à appeler plutôt qu'à réécrire ──

export interface ReuseTarget { name: string; file: string; line: number; sig: string | null }

/** Signature à `line` (1-based), jusqu'à `{`, `=>` ou `:` (Python). null si illisible. */
function extractSignature(root: string, file: string, line: number): string | null {
  try {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    if (line < 1 || line > lines.length) return null;
    let buf = "";
    for (let i = line - 1; i < Math.min(lines.length, line - 1 + 4); i++) {
      const raw = lines[i];
      buf += (buf ? " " : "") + raw.trim();
      const arrow = buf.indexOf("=>");
      const brace = buf.indexOf("{");
      if (arrow >= 0 && (brace < 0 || arrow < brace)) { buf = buf.slice(0, arrow); break; }
      if (brace >= 0) { buf = buf.slice(0, brace); break; }
      if (/:\s*$/.test(raw) && /\bdef\s/.test(buf)) { buf = buf.replace(/:\s*$/, ""); break; }
    }
    buf = buf.replace(/^(?:export\s+|default\s+)+/, "").replace(/\s+/g, " ").trim();
    if (!buf) return null;
    return buf.length > 120 ? buf.slice(0, 117) + "…" : buf;
  } catch {
    return null;
  }
}

/** Top symboles exportés à réutiliser: score = fréquence d'appel + match lexical du nom. */
export function reuseTargets(
  index: CodebaseIndex,
  promptTokens: string[],
  zones: string[],
  root: string | undefined,
  max = 3
): ReuseTarget[] {
  if (!zones.length || !root) return [];
  if (process.env.KURTEL_NO_REUSE) return [];
  // Appels entrants par symbole (les `calls` sont des cibles "file::name").
  const calledCount = new Map<string, number>();
  for (const m of index.modules) for (const s of m.symbols) for (const c of s.calls) {
    calledCount.set(c, (calledCount.get(c) ?? 0) + 1);
  }
  const inZone = (id: string) => {
    const zone = id.includes("/") ? id.split("/").slice(0, 2).join("/") : id;
    return zones.some((z) => zone === z || id.startsWith(z));
  };
  // Portée = zones résolues + leurs imports directs (le helper vit souvent dans un module importé).
  const allowed = new Set<string>();
  for (const m of index.modules) {
    if (!inZone(m.id)) continue;
    allowed.add(m.id);
    for (const imp of m.imports) allowed.add(imp);
  }
  const scored: { t: ReuseTarget; score: number }[] = [];
  for (const m of index.modules) {
    if (!allowed.has(m.id)) continue;
    const exported = new Set(m.exports);
    for (const s of m.symbols) {
      if (s.name === "(module)" || !exported.has(s.name)) continue;
      const nl = s.name.toLowerCase();
      let score = calledCount.get(`${m.id}::${s.name}`) ?? 0;
      for (const tk of promptTokens) if (nl.includes(tk) || tk.includes(nl)) score += 2;
      if (score <= 0) continue;
      scored.push({ t: { name: s.name, file: m.id, line: s.line, sig: null }, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max).map((x) => x.t);
  for (const t of top) t.sig = extractSignature(root, t.file, t.line); // résolution paresseuse: top uniquement
  return top;
}

// ── Compilation de la capsule ───────────────────────────────────────────────

export interface CapsuleResult {
  text: string;
  injectedPatternIds: string[];
  zones: string[];
}

export function compileCapsule(
  index: CodebaseIndex | null,
  patterns: DarwinPattern[],
  prompt: string,
  root?: string
): CapsuleResult | null {
  const tokens = tokenize(prompt);
  if (!tokens.length) return null;

  // Contexte sémantique (optionnel, synchrone): pont FR→EN. Silencieux si pas de table.
  let sem: SemanticContext | undefined;
  if (index && root && embeddingsAvailable()) {
    const mvec = loadModuleVectors(root);
    // On embed les tokens DÉJÀ filtrés (sans stopwords) — averager le prompt brut
    // diluerait le signal et écraserait la discrimination entre zones.
    if (mvec) sem = { q: embedTokens(tokens), mvec };
  }

  const zones = index ? resolveZones(index, tokens, sem) : [];
  const selected = selectPatterns(patterns, tokens, zones);
  const routes = index ? relevantRoutes(index, tokens, sem) : [];
  const reuse = index ? reuseTargets(index, tokens, zones, root) : [];
  const gods = index
    ? index.god_nodes.filter((g) => zones.some((z) => g.id.startsWith(z))).slice(0, 2)
    : [];

  if (!selected.length && !routes.length && !reuse.length && !gods.length) return null; // le silence est le défaut

  const parts: string[] = [];
  parts.push(`[Kurtel memory — auto-injected, relevant to this task only]`);

  if (routes.length) {
    parts.push(`Existing routes in this area (do NOT recreate; extend or reuse):`);
    for (const r of routes) parts.push(`- ${r.method} ${r.path} → ${r.file}:${r.line}`);
  }

  if (reuse.length) {
    parts.push(`Reusable functions in this area (call these, don't reimplement; no need to open the file):`);
    for (const r of reuse) parts.push(`- ${r.sig ?? `${r.name}(…)`} → ${r.file}:${r.line}`);
  }

  if (selected.length) {
    parts.push(`Team conventions learned from merged PRs (follow them):`);
    for (const { pattern } of selected) {
      const conf = Math.round(pattern.score * 100);
      parts.push(`- ${pattern.rule} (confidence ${conf}%)`);
    }
  }

  if (gods.length) {
    parts.push(`High-coupling modules in this zone — changes here have a wide blast radius, check dependents:`);
    for (const g of gods) parts.push(`- ${g.id} (${g.degree} edges)`);
  }

  let text = parts.join("\n");
  if (text.length > TOKEN_BUDGET_CHARS) text = text.slice(0, TOKEN_BUDGET_CHARS - 1) + "…";

  return { text, injectedPatternIds: selected.map((s) => s.pattern.id), zones };
}

// ── Capsule de zone (dérive d'intention en cours de session) ────────────────

export function compileZoneCapsule(
  index: CodebaseIndex | null,
  patterns: DarwinPattern[],
  filePath: string
): CapsuleResult | null {
  const zone = filePath.includes("/") ? filePath.split("/").slice(0, 2).join("/") : filePath;
  const zonePatterns = patterns.filter(
    (p) => p.score >= 0.3 && p.zones.some((z) => zone.startsWith(z) || z.startsWith(zone))
  ).sort((a, b) => b.score - a.score).slice(0, 3);

  const zoneRoutes = index ? index.routes.filter((r) => r.file.startsWith(zone)).slice(0, 5) : [];

  if (!zonePatterns.length && !zoneRoutes.length) return null;

  const parts: string[] = [`[Kurtel memory — you just entered zone "${zone}"]`];
  if (zonePatterns.length) {
    parts.push(`Conventions for this zone:`);
    for (const p of zonePatterns) parts.push(`- ${p.rule}`);
  }
  if (zoneRoutes.length) {
    parts.push(`Routes defined here:`);
    for (const r of zoneRoutes) parts.push(`- ${r.method} ${r.path} (${r.file}:${r.line})`);
  }

  let text = parts.join("\n");
  if (text.length > 800) text = text.slice(0, 799) + "…";
  return { text, injectedPatternIds: zonePatterns.map((p) => p.id), zones: [zone] };
}

export { findSimilarRoutes };
