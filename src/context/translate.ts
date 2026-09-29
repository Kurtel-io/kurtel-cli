import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cosine, embedTokens, foldAccents, nearestWords } from "./embeddings.js";
import { cacheDir } from "../storage/paths.js";

// Maps request words to the code's own words through the bilingual vector table, e.g. "mémoire" → "memory".
// A code word is kept only when it is among the closest words of the request word in the whole table,
// so a request about something the code does not contain adds nothing.

const MIN_SIMILARITY = 0.4;
const MAX_RANK = 15;
const MIN_MARGIN = 0.05;
const SCANNED_ROWS = 20000;
const NEIGHBOURS = 40;
const CACHE_LIMIT = 2000;

const STOP = new Set("avec dans pour sans sous vers chez entre depuis pendant quand comment pourquoi quel quelle quels quelles cette ceci cela celui celle ceux elles nous vous leur leurs mais donc alors aussi encore toujours jamais plus moins tres trop tout tous toute toutes etre avoir fait faire faut peut peux doit dois veux voudrais ajoute ajouter corrige corriger modifie modifier change changer supprime supprimer marche fonctionne probleme bug erreur about after again also because been before being could does doing each from have having here into more most much only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your".split(" "));

type Neighbours = Record<string, [string, number][]>;

function cacheFile(root: string): string {
  return join(cacheDir(root), "neighbours.json");
}

function readCache(root: string): Neighbours {
  try {
    const file = cacheFile(root);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Neighbours : {};
  } catch { return {}; }
}

function writeCache(root: string, cache: Neighbours): void {
  try {
    const keys = Object.keys(cache);
    for (const key of keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT))) delete cache[key];
    const file = cacheFile(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  } catch { /* the cache is optional */ }
}

/** Request words worth translating: folded, at least four letters, not function words. */
export function requestWords(text: string): string[] {
  return [...new Set(foldAccents(text.toLowerCase()).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w)))];
}

/** Code words (from `vocabulary`) that translate request words, mapped to the request word they come from. */
export function codeTranslations(root: string | null, words: string[], vocabulary: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  const unknown = words.filter(w => !vocabulary.has(w));
  if (!unknown.length) return found;
  const code: [string, Float32Array][] = [];
  for (const word of vocabulary) {
    const v = embedTokens([word]);
    if (v) code.push([word, v]);
  }
  if (!code.length) return found;
  const cache = root ? readCache(root) : {};
  let changed = false;
  for (const word of unknown) {
    const q = embedTokens([word]);
    if (!q) continue;
    const scored = code.map(([w, v]) => [w, cosine(q, v)] as [string, number]).sort((a, b) => b[1] - a[1]);
    const best = scored[0];
    if (!best || best[1] < MIN_SIMILARITY) continue;
    // Ambiguous when another code word (not a variant of the best one) is almost as close.
    const rival = scored.find(([w]) => w.slice(0, 5) !== best[0].slice(0, 5));
    if (rival && best[1] - rival[1] < MIN_MARGIN) continue;
    // Variants of the request word itself (plural, verb forms) do not count as competitors.
    const stem = word.slice(0, 5);
    let neighbours = cache[word];
    if (!neighbours) {
      neighbours = nearestWords(q, SCANNED_ROWS, NEIGHBOURS, w => w.length < 3 || w.slice(0, 5) === stem)
        .map(([w, cos]) => [w, Math.round(cos * 1000) / 1000] as [string, number]);
      cache[word] = neighbours;
      changed = true;
    }
    const target = best;
    const rank = 1 + neighbours.filter(([w, cos]) => cos > target[1] && w !== target[0]).length;
    if (rank <= MAX_RANK && !found.has(target[0])) found.set(target[0], word);
  }
  if (root && changed) writeCache(root, cache);
  return found;
}
