import type { CodebaseIndex } from '../domain/types.js';

// Query scaffolding and common directory names are not evidence of code relevance.
const noise = new Set(('type script app api src scripts lib core index route routes file files source sources code implementation function functions string number boolean facts return only containing identify explain explanation current existing find locate default module modules import imports imported direct directly handler handlers changes change before after which what where when how from into with without this that these those then than the and for not all any its has have does do can should would could will user agent system context path lines line name names test tests true false read write modify anything').split(' '));
function terms(text: string): string[] {
  const parts = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return [...new Set(parts.map(p => p.endsWith('ies') ? p.slice(0, -3) + 'y' : p.length > 4 && p.endsWith('s') ? p.slice(0, -1) : p).filter(p => p.length >= 3 && !noise.has(p)))];
}

/** Code locations, not inferred instructions. The capsule composer enforces the final budget. */
export function navigationContext(index: CodebaseIndex, prompt: string): string[] {
  return navigationScope(index, prompt).lines;
}

/** Navigation lines plus the files they designate: explicit modules, or the anchored definitions (never callers or imports). */
export function navigationScope(index: CodebaseIndex, prompt: string): { lines: string[]; files: string[] } {
  const files: string[] = [];
  const lines = navigate(index, prompt, files);
  return { lines, files: [...new Set(files)] };
}

function navigate(index: CodebaseIndex, prompt: string, files: string[]): string[] {
  // Output-format instructions must not act as retrieval keywords.
  const question = prompt.split(/\b(?:return|retourne[zr]?|respond|do not|ne modifie[zr]?)\b/i)[0];
  const query = terms(question);
  const primary = terms(question.split(/[.!?](?:\s|$)/)[0]);
  if (!query.length) return [];
  const normalized = prompt.replace(/\\/g, '/');
  const explicit = index.modules.filter(m => normalized.includes(m.id));
  const lines: string[] = [];
  if (explicit.length) {
    lines.push('Explicitly referenced modules and direct dependencies (indexed static imports):');
    for (const module of explicit.slice(0, 3)) {
      files.push(module.id);
      lines.push(`- ${module.id}`);
      for (const file of module.imports.slice(0, 8)) lines.push(`  imports: ${file}`);
      const importers = index.modules.filter(m => m.imports.includes(module.id));
      for (const file of importers.slice(0, 12)) lines.push(`  imported by: ${file.id}`);
      if (importers.length > 12) lines.push(`  (${importers.length - 12} more direct importers)`);
    }
    return lines;
  }
  const candidates = index.modules.flatMap(m => m.symbols.filter(s => s.name !== '(module)').map(s => ({
    file: m.id, symbol: s, words: terms(s.name), pathWords: terms(m.id),
  })));
  const frequency = new Map<string, number>();
  for (const c of candidates) for (const word of c.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const ranked = candidates.map(c => {
    const hits = query.filter(t => c.words.includes(t) || (/\d/.test(t) && c.symbol.name.toLowerCase().includes(t)));
    const pathHits = query.filter(t => c.pathWords.includes(t));
    // A path match alone never promotes unrelated functions from the same directory.
    const anchored = hits.length >= 2 || hits.some(t => primary.includes(t) && t.length >= 5 && (frequency.get(t) ?? 0) <= 3);
    const weight = hits.reduce((sum, t) => sum + Math.log(1 + candidates.length / (frequency.get(t) ?? 1)), 0);
    return { ...c, hits, score: anchored ? weight + Math.min(2, pathHits.length) : 0 };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.symbol.line - b.symbol.line);
  if (ranked.length) {
    lines.push('Relevant code definitions (read these locations to verify behavior):');
    const selectedFiles = new Set<string>();
    const covered = new Set<string>();
    const top = ranked.filter(c => {
      if (c.score < ranked[0].score * .3 || selectedFiles.has(c.file) || c.hits.every(t => covered.has(t))) return false;
      selectedFiles.add(c.file);
      for (const hit of c.hits) covered.add(hit);
      return true;
    }).slice(0, 3);
    for (const c of top) { files.push(c.file); lines.push(`- ${c.symbol.name} → ${c.file}:${c.symbol.line}`); }
    const module = index.modules.find(m => m.id === ranked[0].file);
    if (/\b(import|dependenc|module|orchestrat)/i.test(question)) {
      for (const file of module?.imports.slice(0, 3) ?? []) lines.push(`- imports: ${file}`);
    }
    const target = `${ranked[0].file}::${ranked[0].symbol.name}`;
    const callers = candidates.filter(c => c.symbol.calls.includes(target) && !top.some(t => t.file === c.file && t.symbol.line === c.symbol.line));
    for (const c of callers.slice(0, 2)) lines.push(`- caller ${c.symbol.name} → ${c.file}:${c.symbol.line}`);
  }
  const routes = index.routes.map(r => ({ r, hits: query.filter(t => terms(r.path).includes(t)) }))
    .filter(({ hits }) => hits.some(t => t.length >= 5))
    .sort((a, b) => b.hits.length - a.hits.length || a.r.file.localeCompare(b.r.file));
  if (routes.length && (!ranked.length || ranked[0].file.startsWith('app/'))) {
    lines.push('Matching routes:');
    for (const { r } of routes.slice(0, 3)) lines.push(`- ${r.method} ${r.path} → ${r.file}:${r.line}`);
  }
  return lines;
}
