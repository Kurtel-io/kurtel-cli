// Knowledge vectors, computed once per version and stored.
import { contentsWithoutVector, saveVectors, storedVectors } from "../storage/knowledge.js";
import { embedTokens, vectorsInfo } from "./embeddings.js";
import { tokenize } from "./tokenize.js";

/** Identifies the vector table; vectors from another table are recomputed. */
export function vectorTableId(): string | null {
  const info = vectorsInfo();
  return info ? `i8:${info.dim}:${info.words}` : null;
}

/** One byte per dimension (×127). */
function quantize(vector: Float32Array | null): Int8Array | null {
  if (!vector) return null;
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return out;
}

/** Computes up to `limit` missing or stale vectors; returns how many. */
export function refreshKnowledgeVectors(root: string, limit = 2000): number {
  const table = vectorTableId();
  if (!table) return 0;
  // Short batches keep the write lock brief.
  let done = 0;
  while (done < limit) {
    const missing = contentsWithoutVector(root, table, Math.min(500, limit - done));
    if (!missing.length) break;
    saveVectors(root, table, missing.map(m => ({ knowledge_id: m.knowledge_id, version_id: m.version_id, vector: quantize(embedTokens(tokenize(m.content))) })));
    done += missing.length;
  }
  return done;
}

/** Active knowledge close in meaning to the task words. */
export function semanticMatches(root: string, words: string[], minimum = 0.65, limit = 50): string[] {
  const table = vectorTableId(), query = table ? embedTokens(words) : null;
  if (!table || !query) return [];
  const scored: { id: string; score: number }[] = [];
  for (const { knowledge_id, vector } of storedVectors(root, table)) {
    if (vector.length !== query.length) continue;
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += query[i] * vector[i];
    dot /= 127;
    if (dot >= minimum) scored.push({ id: knowledge_id, score: dot });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.id);
}
