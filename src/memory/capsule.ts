import type { CodebaseIndex, DarwinPattern, RouteEntry } from "./store.js";
import { findSimilarRoutes } from "./indexer.js";

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

// ── Résolution spatiale: quelles zones du repo l'intention touche-t-elle ? ──

export function resolveZones(index: CodebaseIndex, promptTokens: string[]): string[] {
  const scores = new Map<string, number>();
  for (const m of index.modules) {
    const hay = m.id.toLowerCase();
    let s = 0;
    for (const t of promptTokens) if (hay.includes(t)) s += 2;
    for (const e of m.exports) {
      const el = e.toLowerCase();
      for (const t of promptTokens) if (el.includes(t)) s += 1;
    }
    if (s > 0) {
      const zone = m.id.includes("/") ? m.id.split("/").slice(0, 2).join("/") : m.id;
      scores.set(zone, (scores.get(zone) ?? 0) + s);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([z]) => z);
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

export function relevantRoutes(index: CodebaseIndex, promptTokens: string[]): RouteEntry[] {
  const scored = index.routes.map((r) => {
    const hay = `${r.path} ${r.file}`.toLowerCase();
    let s = 0;
    for (const t of promptTokens) if (hay.includes(t)) s++;
    return { r, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.r);
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
  prompt: string
): CapsuleResult | null {
  const tokens = tokenize(prompt);
  if (!tokens.length) return null;

  const zones = index ? resolveZones(index, tokens) : [];
  const selected = selectPatterns(patterns, tokens, zones);
  const routes = index ? relevantRoutes(index, tokens) : [];
  const gods = index
    ? index.god_nodes.filter((g) => zones.some((z) => g.id.startsWith(z))).slice(0, 2)
    : [];

  if (!selected.length && !routes.length && !gods.length) return null; // le silence est le défaut

  const parts: string[] = [];
  parts.push(`[Kurtel memory — auto-injected, relevant to this task only]`);

  if (routes.length) {
    parts.push(`Existing routes in this area (do NOT recreate; extend or reuse):`);
    for (const r of routes) parts.push(`- ${r.method} ${r.path} → ${r.file}:${r.line}`);
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
