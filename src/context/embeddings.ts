import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CodebaseIndex } from "../domain/types.js";
import { userVectorsDir, vectorsReadPaths, vectorsPathsIn } from "../storage/paths.js";

// {word -> vector} table read as binary; pure synchronous lookup. Missing or unreadable: null everywhere (lexical fallback).
// Format ~/.kurtel/vectors/: vocab.txt (one word per line, line i = vector i);
// vectors.bin = 12-byte header "KVEC"(4)|version u8|quant u8 (1=int8)|dim u16|count u32 (LE) + int8 matrix (L2-normalized ×127).

const MAGIC = "KVEC";
const HEADER = 12;

/** Normalize accents before tokenization and vector lookup. */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

interface Table { dim: number; words: Map<string, number>; data: Int8Array }

let table: Table | null = null;
let loadFailed = false;

/** Loads the table once (lazily). Null if missing or unreadable: lexical fallback. */
function getTable(): Table | null {
  if (table) return table;
  if (loadFailed) return null;
  try {
    const { bin, vocab } = vectorsReadPaths();
    if (!existsSync(bin) || !existsSync(vocab)) { loadFailed = true; return null; }
    const buf = readFileSync(bin);
    if (buf.length < HEADER || buf.toString("latin1", 0, 4) !== MAGIC) { loadFailed = true; return null; }
    const dim = buf.readUInt16LE(6);
    const count = buf.readUInt32LE(8);
    if (dim <= 0 || count <= 0 || buf.length < HEADER + count * dim) { loadFailed = true; return null; }
    // int8 has no alignment constraint: direct view, O(1).
    const data = new Int8Array(buf.buffer, buf.byteOffset + HEADER, count * dim);
    const lines = readFileSync(vocab, "utf8").split("\n");
    const words = new Map<string, number>();
    for (let i = 0; i < count && i < lines.length; i++) {
      const w = lines[i];
      if (!w) continue;
      // Accent-folded keys: queries arrive folded, so "gere" must find "gère"
      // the .vec is sorted by frequency and the more frequent word wins.
      const k = foldAccents(w);
      if (!words.has(k)) words.set(k, i);
    }
    table = { dim, words, data };
    return table;
  } catch {
    loadFailed = true;
    return null;
  }
}

/** Whether the table is available. */
export function embeddingsAvailable(): boolean {
  return getTable() !== null;
}

/** Dimension of the current vector space, 0 without a table. */
export function embeddingDim(): number {
  return getTable()?.dim ?? 0;
}

/** Table metadata for `kurtel memory vectors status`. */
export function vectorsInfo(): { words: number; dim: number } | null {
  const t = getTable();
  return t ? { words: t.words.size, dim: t.dim } : null;
}

// chargeCustomer → ["charge","customer"] ; get_invoice → ["get","invoice"]
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/[_\-./\\]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")     // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")  // HTTPServer → HTTP Server
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && /[a-z]/.test(w));
}

function rawWords(text: string): string[] {
  return foldAccents(text.toLowerCase()).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
}

/** Vector of a set of (already split) words. Null without a table or a known word. */
export function embedTokens(words: string[]): Float32Array | null {
  const t = getTable();
  if (!t) return null;
  const acc = new Float32Array(t.dim);
  let hits = 0;
  for (const w of words) {
    // Folded lookup: words passed here may still carry accents.
    const row = t.words.get(foldAccents(w));
    if (row === undefined) continue;
    const base = row * t.dim;
    for (let i = 0; i < t.dim; i++) acc[i] += t.data[base + i] / 127; // dequantize
    hits++;
  }
  if (!hits) return null;
  let norm = 0;
  for (let i = 0; i < t.dim; i++) norm += acc[i] * acc[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < t.dim; i++) acc[i] /= norm;
  return acc;
}

/** Vector of a text (prompt FR). */
export function embedText(text: string): Float32Array | null {
  return embedTokens(rawWords(text));
}

/** Cosine similarity. Vectors from embedTokens are normalized, so this is a dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Bag of words of a module: path segments, exports and symbol names. */
function moduleWords(m: CodebaseIndex["modules"][number]): string[] {
  const words: string[] = [];
  for (const seg of m.id.replace(/\.[a-z]+$/, "").split(/[\\/]/)) words.push(...splitIdentifier(seg));
  for (const e of m.exports) words.push(...splitIdentifier(e));
  for (const s of m.symbols ?? []) words.push(...splitIdentifier(s.name));
  return words;
}

export interface ModuleVectors { dim: number; ids: string[]; matrix: Float32Array }

/** Builds one vector per module. Null without a table (onboard skips this step). */
export function buildModuleVectors(index: CodebaseIndex): ModuleVectors | null {
  const t = getTable();
  if (!t) return null;
  const ids = index.modules.map((m) => m.id);
  const matrix = new Float32Array(ids.length * t.dim);
  for (let r = 0; r < index.modules.length; r++) {
    const v = embedTokens(moduleWords(index.modules[r]));
    if (v) matrix.set(v, r * t.dim); // otherwise a zero vector (cosine 0, neutral)
  }
  return { dim: t.dim, ids, matrix };
}

// .vec format: first line "count dim", then "word v1 v2 … vdim" per line, sorted by frequency.

const HEADER_RE = /^\s*\d+\s+\d+\s*$/;

function readExistingTable(dir: string): { dim: number; body: Buffer; vocab: string[] } | null {
  const { bin, vocab } = vectorsPathsIn(dir);
  if (!existsSync(bin) || !existsSync(vocab)) return null;
  const buf = readFileSync(bin);
  if (buf.length < HEADER || buf.toString("latin1", 0, 4) !== MAGIC) return null;
  const dim = buf.readUInt16LE(6);
  const count = buf.readUInt32LE(8);
  const body = buf.subarray(HEADER, HEADER + count * dim);
  const lines = readFileSync(vocab, "utf8").split("\n").filter(Boolean).slice(0, count);
  return { dim, body, vocab: lines };
}

export interface ImportResult { added: number; total: number; dim: number; dir: string }

/** Converts a .vec (fastText, word2vec) into a compact int8 table merged with the existing one.
 *  outDir defaults to ~/.kurtel/vectors; assets/vectors builds the bundled table. */
export async function importVecFile(
  src: string,
  opts: { max?: number; outDir?: string; onProgress?: (n: number) => void } = {}
): Promise<ImportResult> {
  if (!existsSync(src)) throw new Error(`file not found: ${src}`);
  const max = opts.max ?? 40000;
  const outDir = opts.outDir ?? userVectorsDir();

  const existing = readExistingTable(outDir);
  const seen = new Set(existing?.vocab ?? []);
  const newWords: string[] = [];
  const newBytes: number[] = [];
  let dim = existing?.dim ?? 0;
  let added = 0;

  const rl = createInterface({ input: createReadStream(src, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (HEADER_RE.test(line)) { if (dim === 0) dim = parseInt(line.trim().split(/\s+/)[1], 10); continue; }
      if (added >= max) break; // sorted by frequency: stop early instead of reading the remaining gigabytes

      const sp = line.indexOf(" ");
      if (sp <= 0) continue;
      const word = line.slice(0, sp);
      if (seen.has(word)) continue;

      const parts = line.slice(sp + 1).trim().split(/\s+/);
      if (dim === 0) dim = parts.length;
      if (parts.length !== dim) continue;
      if (existing && dim !== existing.dim) {
        throw new Error(`dim mismatch: table is ${existing.dim}d, file is ${dim}d`);
      }

      let norm = 0;
      const vals = new Array<number>(dim);
      for (let i = 0; i < dim; i++) { const v = Number(parts[i]); vals[i] = v; norm += v * v; }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) newBytes.push(Math.max(-127, Math.min(127, Math.round((vals[i] / norm) * 127))));

      newWords.push(word);
      seen.add(word);
      added++;
      if (opts.onProgress && added % 2000 === 0) opts.onProgress(added);
    }
  } finally {
    rl.close();
  }

  if (dim === 0) throw new Error("could not determine vector dimension from file");

  const existingBody = existing?.body ?? Buffer.alloc(0);
  const total = (existing?.vocab.length ?? 0) + added;
  const header = Buffer.alloc(HEADER);
  header.write(MAGIC, 0, "latin1");
  header.writeUInt8(1, 4);            // version
  header.writeUInt8(1, 5);            // quant = int8
  header.writeUInt16LE(dim, 6);
  header.writeUInt32LE(total, 8);

  const out = Buffer.concat([header, existingBody, Buffer.from(Int8Array.from(newBytes).buffer)]);

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const { bin, vocab } = vectorsPathsIn(outDir);
  writeFileSync(bin, out);
  writeFileSync(vocab, [...(existing?.vocab ?? []), ...newWords].join("\n") + "\n", "utf8");

  table = null; // invalidate the in-process cache
  loadFailed = false;

  return { added, total, dim, dir: outDir };
}
