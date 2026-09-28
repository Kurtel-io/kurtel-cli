import { statSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseIndex } from "../domain/types.js";
import { digest } from "./knowledge.js";
import { indexGeneratedAt } from "./graph-index.js";
import { currentBranch } from "../repository/git.js";

export interface CodeObservation { file: string; shape: string[]; loc: number }
const safe = (file: string) => !!file && !/[\\:]/.test(file) && !file.startsWith("/") && !file.split("/").includes("..");

/** Structural facts from a saved, current graph. Never read arbitrary source content. */
export function codeObservations(root: string, index: CodebaseIndex | null, files: string[]): CodeObservation[] {
  if (!files.length || !index) return [];
  const generated = indexGeneratedAt(root);
  if (!index || !generated || index.branch !== currentBranch(root)) return [];
  return [...new Set(files)].slice(0, 20).flatMap(file => {
    if (!safe(file)) return [];
    const mod = index.modules.find(m => m.id === file);
    if (!mod) return [];
    try { const stat = statSync(join(root, file)); if (!stat.isFile() || stat.mtimeMs > Date.parse(generated)) return []; } catch { return []; }
    return [{ file, loc: mod.loc, shape: [...new Set([...mod.exports.map(s => `export:${s}`), ...mod.imports.map(s => `import:${s}`), ...mod.symbols.map(s => `symbol:${s.name}`)])].sort().slice(0, 500).map(digest) }];
  });
}

export function compareCode(root: string, before: CodeObservation[], current: CodeObservation[]) {
  if (!before.length) return { state: "unknown", similarity: null };
  let lowest = 1, unknown = false;
  for (const old of before) {
    if (!safe(old.file) || !Array.isArray(old.shape)) { unknown = true; continue; }
    try { if (!statSync(join(root, old.file)).isFile()) return { state: "missing", similarity: 0 }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", similarity: 0 }; unknown = true; continue; }
    const next = current.find(c => c.file === old.file);
    if (!next) { unknown = true; continue; }
    const union = new Set([...old.shape, ...next.shape]);
    const structural = union.size ? old.shape.filter(s => next.shape.includes(s)).length / union.size : 1;
    const size = Math.max(old.loc, next.loc) ? Math.min(old.loc, next.loc) / Math.max(old.loc, next.loc) : 1;
    lowest = Math.min(lowest, structural, size);
  }
  return unknown ? { state: "unknown", similarity: null } : { state: lowest === 1 ? "unchanged" : "changed", similarity: lowest };
}
