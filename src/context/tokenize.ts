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

export function tokenize(text: string): string[] {
  // Normalize before splitting so accented French words stay intact.
  return [...new Set(
    foldAccents(text.toLowerCase())
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )];
}

