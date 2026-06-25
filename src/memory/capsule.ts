import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseIndex, DarwinPattern, RouteEntry } from "./store.js";
import { findSimilarRoutes } from "./indexer.js";
import { embeddingsAvailable, embedTokens, cosine } from "./embed.js";
import { loadModuleVectors, dedupePatterns } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Capsule — le cœur du produit. À chaque prompt:
//   intention → résolution spatiale (zones du graphe) → sélection de patterns
//   → capsule compacte (budget ~400 tokens) injectée via le hook.
// Tout se calcule en local, en millisecondes, sans réseau.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_BUDGET_CHARS = 2400; // ~600 tokens — budget rempli en skills ENTIERS
const MAX_PATTERNS = 20;         // borne haute; le budget en lignes fait le vrai tri

// Assemble des lignes ENTIÈRES sous un budget de caractères: on n'ajoute que des
// lignes complètes et on s'arrête net — jamais de règle coupée en plein milieu
// (qui ferait lire à l'agent du texte tronqué = bruit, voire fausse info).
function fitLines(parts: string[], budget: number): string {
  const out: string[] = [];
  let len = 0;
  for (const line of parts) {
    const add = line.length + 1;
    if (len + add > budget) break;
    out.push(line);
    len += add;
  }
  // Pas d'en-tête de section orphelin en fin (ligne finissant par ":").
  while (out.length && out[out.length - 1].trimEnd().endsWith(":")) out.pop();
  return out.join("\n");
}
const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "in", "on", "and", "or", "with", "add",
  "create", "make", "fix", "update", "change", "new", "page", "file", "please",
  "can", "could", "would", "should", "that", "this", "these", "those", "your", "our",
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "pour", "dans",
  "ajoute", "ajouter", "crée", "creer", "modifie", "modifier", "corrige", "il", "faut",
  // mots-outils FR fréquents qui survivaient à la tokenisation (≥3 lettres, non accentués)
  // et créaient de faux hits lexicaux (ex: "qui" ⊂ "required").
  "qui", "que", "quoi", "dont", "nos", "vos", "mes", "tes", "ses", "son", "sur",
  "par", "ces", "cet", "cette", "ce", "se", "sa", "ne", "pas", "plus", "peux",
  "peut", "nous", "vous", "est", "est-ce", "comme", "mais", "donc", "car", "leur",
  "leurs", "tout", "tous", "avec", "sans", "ton", "tes", "ver", "via",
]);

export function tokenize(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )];
}

// Match d'un token de prompt contre un trigger. L'égalité compte toujours; le
// containment de sous-chaîne n'est autorisé que si LA PLUS COURTE des deux fait
// ≥ 4 chars — sinon un token court (ex: "qui") s'incruste dans un mot plus long
// ("re-QUI-red") et vole un hit lexical de domaine. Tue toute la classe des
// faux positifs sur tokens de 3 lettres (cf. diagnostic 2026-06-24).
function triggerMatches(token: string, trigger: string): boolean {
  if (token === trigger) return true;
  const shorter = token.length <= trigger.length ? token : trigger;
  if (shorter.length < 4) return false;
  return trigger.includes(token) || token.includes(trigger);
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
const SEM_WEIGHT_PATTERN = 10; // un fort match sémantique vaut ~1 hit de trigger lexical

// Porte de pertinence PROPRE aux conventions (≠ zones/routes, ancrées structurellement).
// Les word-vectors moyennés ont une ligne de base de cosinus élevée et dépendante du
// prompt: SEM_FLOOR=0.30 est SOUS la médiane de bruit → presque chaque convention le
// franchit (diagnostic 2026-06-24). Une convention sémantique-SEULE (sans ancre lexicale
// ni de zone) ne s'affiche que si son cosinus est à la fois absolument fort ET au-dessus
// de la médiane des cosinus du prompt avec une marge — c.-à-d. un vrai rescue paraphrase
// (rare ET fort, cf. billing→stripe), pas un effleurement dans la bande de bruit.
const SEM_PATTERN_GATE = 0.50;  // plancher absolu pour une convention sémantique-seule
const SEM_REL_MARGIN = 0.10;    // …et au-dessus de la médiane du prompt de cette marge

function semScore(sem: SemanticContext | undefined, id: string, weight: number): number {
  if (!sem?.q || !sem.mvec) return 0;
  const v = sem.mvec.get(id);
  if (!v) return 0;
  const cs = cosine(sem.q, v);
  return cs > SEM_FLOOR ? (cs - SEM_FLOOR) * weight : 0;
}

// Le score sémantique d'un PATTERN (cosinus prompt FR ↔ triggers EN, table alignée)
// est désormais calculé inline dans `selectPatterns` — le cosinus y sert deux fois
// (scoring ET porte de pertinence relative à la médiane du prompt), donc on le calcule
// une seule fois par pattern au lieu de via un helper appelé en boucle.

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
  max = MAX_PATTERNS,
  sem?: SemanticContext
): SelectedPattern[] {
  // Cosinus prompt↔triggers par pattern, calculé une fois. Sert au scoring ET à la
  // porte de pertinence (gate relatif à la médiane du prompt). Vide si pas de table.
  const cosOf = new Map<DarwinPattern, number>();
  if (sem?.q) {
    for (const p of patterns) {
      const toks = p.triggers.length ? p.triggers : tokenize(p.rule);
      const v = toks.length ? embedTokens(toks) : null;
      if (v) cosOf.set(p, cosine(sem.q, v));
    }
  }
  // Médiane des cosinus du prompt = sa ligne de base de bruit. La porte sémantique
  // exige de la dépasser (gate relatif), en plus du plancher absolu.
  const cosVals = [...cosOf.values()].sort((a, b) => a - b);
  const median = cosVals.length ? cosVals[Math.floor(cosVals.length / 2)] : 0;
  const semGate = Math.max(SEM_PATTERN_GATE, median + SEM_REL_MARGIN);

  const out: SelectedPattern[] = [];
  for (const p of patterns) {
    if (p.score < 0.3 && !p.pinned) continue; // les mourants ne parlent plus
    let s = 0;
    let anchored = false; // ancre RÉELLE: trigger lexical borné, hit de zone, ou rescue sémantique fort
    if (p.pinned) s += 10; // socle: toujours présent (override humain → bypasse la porte)
    for (const trig of p.triggers) {
      if (promptTokens.some((t) => triggerMatches(t, trig.toLowerCase()))) { s += 4; anchored = true; }
    }
    for (const z of p.zones) {
      if (zones.some((zone) => zone.startsWith(z) || z.startsWith(zone))) { s += 3; anchored = true; }
    }
    // Pont sémantique: surface un skill pertinent même SANS recouvrement lexical de
    // triggers (paraphrase, FR↔EN). Critique quand la mémoire est la source primaire
    // (remplace un AGENTS.md): un raté de routage = la convention n'atteint pas l'agent.
    const cs = cosOf.get(p) ?? 0;
    if (cs > SEM_FLOOR) s += (cs - SEM_FLOOR) * SEM_WEIGHT_PATTERN;
    if (cs >= semGate) anchored = true; // rescue paraphrase: rare ET fort, au-dessus du bruit
    if (p.zones.length === 0 && s > 0) s += 1; // global + déjà pertinent
    // Porte de pertinence: une convention ne s'affiche qu'avec une ancre réelle. Un
    // effleurement sémantique dans la bande de bruit (0.30–gate) ne suffit PAS — c'est
    // ce qui injectait 8 conventions hors-sujet à 100%. Pinned bypasse toujours.
    if ((p.pinned || anchored) && s > 0) out.push({ pattern: p, score: s * (0.5 + p.score) });
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

  // Défense au point d'injection: même si le cache contient des doublons (orphelins
  // d'un ré-onboard non encore purgés), jamais deux fois la même règle dans la capsule.
  patterns = dedupePatterns(patterns);

  // Contexte sémantique (optionnel, synchrone): pont FR→EN. Silencieux si pas de table.
  let sem: SemanticContext | undefined;
  if (embeddingsAvailable()) {
    // On embed les tokens DÉJÀ filtrés (sans stopwords) — averager le prompt brut
    // diluerait le signal. `q` seul suffit au routage sémantique des skills; les
    // vecteurs de modules (si présents) enrichissent en plus les zones/routes.
    const q = embedTokens(tokens);
    if (q) sem = { q, mvec: index && root ? loadModuleVectors(root) : null };
  }

  const zones = index ? resolveZones(index, tokens, sem) : [];
  const selected = selectPatterns(patterns, tokens, zones, MAX_PATTERNS, sem);
  const routes = index ? relevantRoutes(index, tokens, sem) : [];
  const reuse = index ? reuseTargets(index, tokens, zones, root) : [];
  const gods = index
    ? index.god_nodes.filter((g) => zones.some((z) => g.id.startsWith(z))).slice(0, 2)
    : [];

  if (!selected.length && !routes.length && !reuse.length && !gods.length) return null; // le silence est le défaut

  const header = `[Kurtel memory — auto-injected, relevant to this task only]`;

  // Un `pinned` est un override humain: il prime sur l'anti-bruit. On le rend EN
  // PREMIER et on l'EXEMPTE du budget — il ne doit jamais être évincé par un encart
  // de routes/reuse. Seul le reste passe sous `fitLines`.
  const pinnedSel = selected.filter((s) => s.pattern.pinned);
  const restSel = selected.filter((s) => !s.pattern.pinned);

  const pinnedParts: string[] = [];
  if (pinnedSel.length) {
    pinnedParts.push(`Pinned conventions (always apply):`);
    for (const { pattern } of pinnedSel) pinnedParts.push(`- ${pattern.rule}`);
  }

  const parts: string[] = [];

  if (routes.length) {
    parts.push(`Existing routes in this area (do NOT recreate; extend or reuse):`);
    for (const r of routes) parts.push(`- ${r.method} ${r.path} → ${r.file}:${r.line}`);
  }

  if (reuse.length) {
    parts.push(`Reusable functions in this area (call these, don't reimplement; no need to open the file):`);
    for (const r of reuse) parts.push(`- ${r.sig ?? `${r.name}(…)`} → ${r.file}:${r.line}`);
  }

  if (restSel.length) {
    parts.push(`Team conventions learned from merged PRs (follow them):`);
    for (const { pattern } of restSel) {
      const conf = Math.round(pattern.score * 100);
      parts.push(`- ${pattern.rule} (confidence ${conf}%)`);
    }
  }

  if (gods.length) {
    parts.push(`High-coupling modules in this zone — changes here have a wide blast radius, check dependents:`);
    for (const g of gods) parts.push(`- ${g.id} (${g.degree} edges)`);
  }

  // Le bloc pinned est garanti; le budget restant ne s'applique qu'au reste.
  const pinnedText = pinnedParts.join("\n");
  const remaining = TOKEN_BUDGET_CHARS - (pinnedText ? pinnedText.length + 1 : 0);
  const restText = fitLines(parts, Math.max(0, remaining));
  const text = [header, pinnedText, restText].filter(Boolean).join("\n");

  // Télémétrie honnête: les pinned sont toujours présents; pour le reste, on ne
  // compte que les patterns réellement rendus (une ligne sautée au budget ne compte pas).
  const injectedPatternIds = [
    ...pinnedSel.map((s) => s.pattern.id),
    ...restSel.filter((s) => restText.includes(s.pattern.rule)).map((s) => s.pattern.id),
  ];

  return { text, injectedPatternIds, zones };
}

// ── Capsule de zone (dérive d'intention en cours de session) ────────────────

export function compileZoneCapsule(
  index: CodebaseIndex | null,
  patterns: DarwinPattern[],
  filePath: string
): CapsuleResult | null {
  const zone = filePath.includes("/") ? filePath.split("/").slice(0, 2).join("/") : filePath;
  patterns = dedupePatterns(patterns);
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

  const text = fitLines(parts, 900);
  return {
    text,
    injectedPatternIds: zonePatterns.filter((p) => text.includes(p.rule)).map((p) => p.id),
    zones: [zone],
  };
}

export { findSimilarRoutes };
