import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CodebaseIndex } from "./store.js";
import { userVectorsDir, vectorsReadPaths, vectorsPathsIn } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Embeddings sémantiques — word-vectors ALIGNÉS cross-lingues (ex: fastText
// aligned). Le pari: relier un prompt FR ("encaisser un client") à du code EN
// (stripeCharge.ts) sans table de synonymes ni modèle neuronal.
//   · Pas de runtime: une table {mot → vecteur} lue en binaire, lookup pur.
//   · Tout SYNCHRONE → compileCapsule ne change pas de nature. Pas de daemon,
//     pas de réseau à l'exécution, déterministe.
//   · Si la table est absente/illisible → null partout, la capsule retombe sur
//     le lexical. Même contrat de dégradation que ast.ts (initFailed).
//
// Format de la table (~/.kurtel/vectors/):
//   vocab.txt    — un mot par ligne (UTF-8), ligne i ↔ vecteur i
//   vectors.bin  — header 12 o + matrice int8 (vecteurs L2-normalisés ×127)
//     header: "KVEC"(4) | version u8 | quant u8(1=int8) | dim u16 | count u32  (LE)
// ─────────────────────────────────────────────────────────────────────────────

const MAGIC = "KVEC";
const HEADER = 12;

interface Table { dim: number; words: Map<string, number>; data: Int8Array }

let table: Table | null = null;
let loadFailed = false;

/** Charge la table une fois (lazy). Renvoie null si absente/illisible — fallback lexical. */
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
    // int8 n'a aucune contrainte d'alignement → vue directe, O(1).
    const data = new Int8Array(buf.buffer, buf.byteOffset + HEADER, count * dim);
    const lines = readFileSync(vocab, "utf8").split("\n");
    const words = new Map<string, number>();
    for (let i = 0; i < count && i < lines.length; i++) {
      const w = lines[i];
      if (w) words.set(w, i);
    }
    table = { dim, words, data };
    return table;
  } catch {
    loadFailed = true;
    return null;
  }
}

/** La table est-elle disponible ? (utilisé par onboard pour calculer les vecteurs modules) */
export function embeddingsAvailable(): boolean {
  return getTable() !== null;
}

/** Dimension de l'espace vectoriel courant, ou 0 si pas de table. */
export function embeddingDim(): number {
  return getTable()?.dim ?? 0;
}

/** Méta de la table pour `kurtel memory vectors status`. */
export function vectorsInfo(): { words: number; dim: number } | null {
  const t = getTable();
  return t ? { words: t.words.size, dim: t.dim } : null;
}

// ── Découpage des identifiants de code en sous-mots cherchables ─────────────
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
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
}

// ── Embedding: moyenne des vecteurs des mots trouvés, L2-normalisée ─────────

/** Vecteur d'un ensemble de mots (déjà découpés). null si table absente ou aucun mot connu. */
export function embedTokens(words: string[]): Float32Array | null {
  const t = getTable();
  if (!t) return null;
  const acc = new Float32Array(t.dim);
  let hits = 0;
  for (const w of words) {
    const row = t.words.get(w);
    if (row === undefined) continue;
    const base = row * t.dim;
    for (let i = 0; i < t.dim; i++) acc[i] += t.data[base + i] / 127; // déquantif
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

/** Vecteur d'un texte libre (prompt FR). */
export function embedText(text: string): Float32Array | null {
  return embedTokens(rawWords(text));
}

/** Similarité cosinus. Les vecteurs sortis d'embedTokens sont normalisés → produit scalaire. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// ── Vecteurs des modules (calculés à l'index, côté code anglais) ────────────

/** Sac de mots d'un module: segments du chemin + exports + noms de symboles. */
function moduleWords(m: CodebaseIndex["modules"][number]): string[] {
  const words: string[] = [];
  for (const seg of m.id.replace(/\.[a-z]+$/, "").split(/[\\/]/)) words.push(...splitIdentifier(seg));
  for (const e of m.exports) words.push(...splitIdentifier(e));
  for (const s of m.symbols ?? []) words.push(...splitIdentifier(s.name));
  return words;
}

export interface ModuleVectors { dim: number; ids: string[]; matrix: Float32Array }

/** Construit un vecteur par module. null si pas de table (→ onboard saute l'étape). */
export function buildModuleVectors(index: CodebaseIndex): ModuleVectors | null {
  const t = getTable();
  if (!t) return null;
  const ids = index.modules.map((m) => m.id);
  const matrix = new Float32Array(ids.length * t.dim);
  for (let r = 0; r < index.modules.length; r++) {
    const v = embedTokens(moduleWords(index.modules[r]));
    if (v) matrix.set(v, r * t.dim); // sinon: vecteur nul (cosinus 0, neutre)
  }
  return { dim: t.dim, ids, matrix };
}

// ── Converter: un .vec standard (fastText/word2vec) → notre table compacte ──
// Format .vec: 1ère ligne "count dim", puis "mot v1 v2 … vdim" par ligne.
// On dégraisse au top-N (les .vec sont triés par fréquence), normalise, quantifie
// en int8, et FUSIONNE avec la table existante (pour cumuler FR puis EN alignés).

// "count dim" — ligne d'en-tête word2vec/fastText (que des chiffres, pas de mot).
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

/** Convertit un .vec (fastText/word2vec) → table compacte int8, fusionnée avec l'existante.
 *  outDir par défaut = ~/.kurtel/vectors (override user). Pour builder le bundle: outDir = assets/vectors. */
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
      if (added >= max) break; // .vec trié par fréquence → on s'arrête tôt, on ne lit pas les Go restants

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

      // L2-normalise puis quantifie en int8.
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

  // invalide le cache en mémoire de ce process
  table = null;
  loadFailed = false;

  return { added, total, dim, dir: outDir };
}
