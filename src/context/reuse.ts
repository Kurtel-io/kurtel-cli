import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseIndex } from "../domain/types.js";

export interface ReuseTarget { name: string; file: string; line: number; sig: string | null }

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

export function reuseTargets(
  index: CodebaseIndex,
  promptTokens: string[],
  zones: string[],
  root: string | undefined,
  max = 3
): ReuseTarget[] {
  if (!zones.length || !root) return [];
  if (process.env.KURTEL_NO_REUSE) return [];
  // Incoming calls per symbol (`calls` targets are "file::name").
  const calledCount = new Map<string, number>();
  for (const m of index.modules) for (const s of m.symbols) for (const c of s.calls) {
    calledCount.set(c, (calledCount.get(c) ?? 0) + 1);
  }
  const inZone = (id: string) => {
    const zone = id.includes("/") ? id.split("/").slice(0, 2).join("/") : id;
    return zones.some((z) => zone === z || id.startsWith(z));
  };
  // Scope: resolved zones and their direct imports (helpers often live in an imported module).
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
  for (const t of top) t.sig = extractSignature(root, t.file, t.line); // lazy: top results only
  return top;
}
