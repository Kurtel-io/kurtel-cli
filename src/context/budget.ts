// Room for four whole rules (up to 1,200 characters each, with their source) and the code locations.
export const CONTEXT_TOKENS = 2000;
// Rules chosen for a message are not counted against that room: the limit is the host's.
export const CHOSEN_TOKENS = 8000;
// Claude Code replaces a hook's context over 10,000 characters with a 2,000-character preview.
export const HOOK_CHARACTERS = 9600;
export const TOKENIZER = "estimate-v1";

/**
 * Local reference count; not Claude's billing tokenizer or message framing. An estimate instead of an exact
 * BPE tokenizer: loading one cost about 0.18 s on every prompt hook. Words count one token per 6 letters,
 * numbers one per 3 digits, each symbol 0.8, spaces nothing. Against cl100k on the text Kurtel injects it is never
 * below and about 12 % above on average, so the budget stays a ceiling.
 */
export function countTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu)) {
    const piece = m[0];
    n += /\p{L}/u.test(piece[0]) ? Math.ceil(piece.length / 6) : /\p{N}/u.test(piece[0]) ? Math.ceil(piece.length / 3) : 0.8;
  }
  return Math.ceil(n);
}

export interface ContextItem { key: string; text: string; priority: number; /** Files or scopes the item points at (usage journal). */ files?: string[] }

/** `characters`: a second ceiling, on the length of the text, for a host that cuts long context. */
export function packContext(items: ContextItem[], budget = CONTEXT_TOKENS, characters = Number.POSITIVE_INFINITY) {
  if (!Number.isInteger(budget) || budget < 80 || budget > 8000) throw new Error("Token budget must be an integer between 80 and 8000");
  const header = "[Kurtel context: this repository's project memory and code map, supplied by the Kurtel plugin the user installed here. Each remembered line states who said it and when. Verify code locations.]";
  const selected: ContextItem[] = [], omitted: string[] = [];
  const seen = new Set<string>();
  for (const item of [...items].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))) {
    const normalized = item.text.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const next = [header, ...selected.map(i => i.text), item.text].join("\n\n");
    if (countTokens(next) <= budget && next.length <= characters) selected.push(item);
    else omitted.push(item.key);
  }
  const notice = "Some context was omitted to fit the budget; inspect with kurtel context --json.";
  const render = () => selected.length || omitted.length ? [header, ...selected.map(i => i.text), ...(omitted.length ? [notice] : [])].join("\n\n") : "";
  while (selected.length && (countTokens(render()) > budget || render().length > characters)) omitted.push(selected.pop()!.key);
  const text = render();
  return { text, selected, omitted, tokens: countTokens(text), budget, tokenizer: TOKENIZER };
}
