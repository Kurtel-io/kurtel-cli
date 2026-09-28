import { existsSync, readFileSync, statSync } from "node:fs";
import type { CodebaseIndex } from "../domain/types.js";
import { indexPath } from "./paths.js";
import { writeJSON } from "./json.js";
import { ensureKurtelIgnored } from "./journal.js";

export function indexGeneratedAt(root: string): string | null {
  try {
    return statSync(indexPath(root)).mtime.toISOString();
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
  ensureKurtelIgnored(root);
}

/** Cheap identity of the saved index (size + mtime), so prompts never hash the whole graph. */
export function indexRevision(root: string, index: CodebaseIndex): string {
  try { const s = statSync(indexPath(root)); return `${s.size.toString(36)}.${Math.trunc(s.mtimeMs).toString(36)}`; }
  catch { return `unsaved.${index.files_indexed}.${index.modules.length}.${index.routes.length}`; }
}
