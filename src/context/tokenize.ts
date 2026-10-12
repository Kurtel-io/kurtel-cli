import { foldAccents } from "./embeddings.js";

const STOPWORDS_RAW = [
  "the", "a", "an", "to", "for", "of", "in", "on", "and", "or", "with", "add",
  "create", "make", "fix", "update", "change", "new", "page", "file", "please",
  "can", "could", "would", "should", "that", "this", "these", "those", "your", "our",
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "pour", "dans",
  "ajoute", "ajouter", "crée", "creer", "modifie", "modifier", "corrige", "il", "faut",
  // Frequent French function words that survived tokenization (3+ letters, unaccented) and caused false
  // lexical hits ("qui" inside "required").
  "qui", "que", "quoi", "dont", "nos", "vos", "mes", "tes", "ses", "son", "sur",
  "par", "ces", "cet", "cette", "ce", "se", "sa", "ne", "pas", "plus", "peux",
  "peut", "nous", "vous", "est", "est-ce", "comme", "mais", "donc", "car", "leur",
  "leurs", "tout", "tous", "avec", "sans", "ton", "tes", "ver", "via",
  // accented function words, reachable since tokenization folds accents
  "créé", "créée", "déjà", "être", "où", "après", "très", "même", "général",
];

const STOPWORDS = new Set(STOPWORDS_RAW.map((w) => foldAccents(w)));

/** Every word of a text, repeats kept. */
export function terms(text: string): string[] {
  // Normalize before splitting so accented French words stay intact.
  return foldAccents(text.toLowerCase())
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export function tokenize(text: string): string[] {
  return [...new Set(terms(text))];
}

/**
 * BM25 score of each text for the query words: a rare shared word counts more than a common one, and a long
 * text gains nothing from its length. Rarity is measured among the texts given.
 */
export function lexicalScores(query: string[], texts: string[], k1 = 1.2, b = 0.75): number[] {
  const docs = texts.map(terms), average = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const containing = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) containing.set(w, (containing.get(w) ?? 0) + 1);
  const wanted = [...new Set(query)].filter((w) => containing.has(w));
  return docs.map((d) => {
    const counts = new Map<string, number>();
    for (const w of d) counts.set(w, (counts.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of wanted) {
      const tf = counts.get(w);
      if (!tf) continue;
      const n = containing.get(w)!;
      score += Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * d.length / average));
    }
    return score;
  });
}

