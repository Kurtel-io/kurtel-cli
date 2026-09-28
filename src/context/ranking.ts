import type { CodebaseIndex, RouteEntry } from "../domain/types.js";
import { cosine } from "./embeddings.js";

export interface SemanticContext {
  q: Float32Array | null;                  // prompt vector
  mvec: Map<string, Float32Array> | null;  // id module → vector (code EN)
}

const SEM_FLOOR = 0.30;

const SEM_WEIGHT_ZONE = 8;

const SEM_WEIGHT_ROUTE = 4;

export function semScore(sem: SemanticContext | undefined, id: string, weight: number): number {
  if (!sem?.q || !sem.mvec) return 0;
  const v = sem.mvec.get(id);
  if (!v) return 0;
  const cs = cosine(sem.q, v);
  return cs > SEM_FLOOR ? (cs - SEM_FLOOR) * weight : 0;
}

export function resolveZones(index: CodebaseIndex, promptTokens: string[], sem?: SemanticContext): string[] {
  // Rank a zone by its best match, with a small second-match tie-breaker.
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
    s += semScore(sem, m.id, SEM_WEIGHT_ZONE); // cross-language: surfaced even without a lexical match
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

export function relevantRoutes(index: CodebaseIndex, promptTokens: string[], sem?: SemanticContext): RouteEntry[] {
  const scored = index.routes.map((r) => {
    const hay = `${r.path} ${r.file}`.toLowerCase();
    let s = 0;
    for (const t of promptTokens) if (hay.includes(t)) s++;
    s += semScore(sem, r.file, SEM_WEIGHT_ROUTE); // semantic proximity through the module defining the route
    return { r, s };
  });
  return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.r);
}
