import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest, knowledgePath, readKnowledge } from "./knowledge.js";
import type { PriorHint } from "../memory/tool-observation.js";
import { codeObservations, type CodeObservation } from "./code-observations.js";
import { loadIndex } from "./graph-index.js";
import { countTokens } from "../context/budget.js";

// Paths and keys only: no prompt, memory text or file content leaves the hook in this journal.
const USAGE_MAX_BYTES = 2_000_000;
const CITED = /(?<![\w/.:])(?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z]\w*/g;

export interface InjectedItem { key: string; files: string[]; code?: CodeObservation[] }
type UsageRecord =
  | { t: string; s: string; k: "inject"; e: string; tokens: number; items: InjectedItem[] }
  | { t: string; s: string; k: "tool"; tool: string; file: string };

export function usagePath(root: string): string { return join(dirname(knowledgePath(root)), "context", "usage.jsonl"); }
export const sessionKey = (session: string | undefined) => digest(session ?? "unknown").slice(0, 16);

/** Memory versions delivered to a session, with the time of each delivery (journal order, both generations). */
export function injectedMemories(root: string, session: string): { at: string; version_id: string }[] {
  const out: { at: string; version_id: string }[] = [];
  for (const file of [usagePath(root) + ".old", usagePath(root)]) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of content.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (row.k !== "inject" || row.s !== sessionKey(session) || !Number.isFinite(Date.parse(row.t)) || !Array.isArray(row.items)) continue;
        for (const item of row.items) {
          const match = typeof item?.key === "string" ? /^memory:(?:action|investigation):(.+):[^:]+$/.exec(item.key) : null;
          if (match) out.push({ at: row.t, version_id: match[1] });
        }
      } catch { /* An incomplete journal line is not evidence. */ }
    }
  }
  return out;
}

/** Repository files a context item points at (graph locations, memory scopes, cited paths). */
export function citedFiles(text: string): string[] {
  return [...new Set(text.match(CITED) ?? [])].slice(0, 20);
}

function append(root: string, record: UsageRecord): void {
  if (process.env.KURTEL_NO_INJECTION_LOG) return;
  try {
    const file = usagePath(root);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size > USAGE_MAX_BYTES) { try { rmSync(file + ".old"); } catch { /* No older generation. */ } renameSync(file, file + ".old"); }
    } catch { /* First write. */ }
    appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch { /* The journal must never break a hook. */ }
}

export function recordInjection(root: string, session: string | undefined, event: string, tokens: number, items: { key: string; text: string; files?: string[] }[]): void {
  // Shared payloads and their paths never enter the durable personal journal/store.
  items = items.filter(i => !i.key.startsWith("team:"));
  if (!items.length) return;
  const index = items.some(i => i.key.startsWith("memory:")) ? loadIndex(root) : null;
  const code = codeObservations(root, index, items.filter(i => i.key.startsWith("memory:")).flatMap(i => i.files ?? citedFiles(i.text)));
  append(root, { t: new Date().toISOString(), s: sessionKey(session), k: "inject", e: event, tokens, items: items.map(i => {
    const files = i.files ?? citedFiles(i.text);
    return { key: i.key, files, ...(i.key.startsWith("memory:") ? { code: code.filter(c => files.includes(c.file)) } : {}) };
  }) });
}

export function recordToolUse(root: string, session: string | undefined, tool: string, file: string): void {
  append(root, { t: new Date().toISOString(), s: sessionKey(session), k: "tool", tool, file });
}

/** MCP delivery captured by an assistant hook: keep known memory IDs, never the returned prose. */
export function recordCapturedContext(root: string, session: string, tool: string | undefined, response: unknown): void {
  if (tool !== "mcp__kurtel__get_context") return;
  const body = response as { content?: { type?: string; text?: string }[]; result?: { content?: { type?: string; text?: string }[] } } | null;
  const content = body?.content ?? body?.result?.content;
  const text = typeof response === "string" ? response : Array.isArray(content) ? content.filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
  if (!text || text.length > 100000) return;
  const versions = readKnowledge(root).versions.filter(v => text.includes(`Memory ${v.id}.`));
  recordInjection(root, session, "MCP:get_context", countTokens(text), versions.map(v => ({ key: `memory:action:${v.id}:${digest(text)}`, text: "", files: v.zones })));
}

/** Historical context only: never consult today's graph to infer what was known earlier. */
export function priorInjectionHints(root: string, session: string): PriorHint[] {
  const hints: PriorHint[] = [];
  for (const file of [usagePath(root) + ".old", usagePath(root)]) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of content.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (row.k !== "inject" || row.s !== sessionKey(session) || !Number.isFinite(Date.parse(row.t)) || !Array.isArray(row.items)) continue;
        const files = row.items.flatMap((item: InjectedItem) => Array.isArray(item.files) ? item.files.filter(f => typeof f === "string") : []);
        hints.push({ files, source: { id: `usage:${digest(line)}`, kind: "document", reference: `kurtel-context:${sessionKey(session)}`, revision: null, recorded_at: row.t, content: line } });
      } catch { /* Missing or incomplete journal records are not evidence. */ }
    }
  }
  return hints;
}

const touches = (file: string, cited: string) => file === cited || file.startsWith(cited.replace(/\/$/, "") + "/");

/**
 * An injected item counts as used when a file it cites is read, searched or edited later in the same
 * session. Indirect and non-causal: an agent may have opened the file anyway.
 */
export function usageReport(root: string) {
  let lines: string[] = [];
  for (const file of [usagePath(root) + ".old", usagePath(root)]) { try { lines = lines.concat(readFileSync(file, "utf8").split("\n")); } catch { /* Missing generation. */ } }
  const records: UsageRecord[] = [];
  for (const line of lines) { if (!line.trim()) continue; try { records.push(JSON.parse(line)); } catch { /* Torn line after a crash. */ } }
  const events: Record<string, { injections: number; tokens: number; items: number; citing: number; used: number }> = {};
  const memory = { items: 0, citing: 0, used: 0 };
  let citedFilesCount = 0, usedFilesCount = 0;
  records.forEach((r, i) => {
    if (r.k !== "inject") return;
    const bucket = events[r.e] ??= { injections: 0, tokens: 0, items: 0, citing: 0, used: 0 };
    bucket.injections++; bucket.tokens += r.tokens;
    const later = records.slice(i + 1).filter((x): x is Extract<UsageRecord, { k: "tool" }> => x.k === "tool" && x.s === r.s);
    for (const item of r.items) {
      citedFilesCount += item.files.length;
      usedFilesCount += item.files.filter(f => later.some(x => touches(x.file, f))).length;
      const used = item.files.some(f => later.some(x => touches(x.file, f)));
      bucket.items++; if (item.files.length) bucket.citing++; if (used) bucket.used++;
      if (item.key.startsWith("memory:") || item.key.startsWith("legacy:")) { memory.items++; if (item.files.length) memory.citing++; if (used) memory.used++; }
    }
  });
  const total = Object.values(events).reduce((a, b) => ({ items: a.items + b.items, citing: a.citing + b.citing, used: a.used + b.used }), { items: 0, citing: 0, used: 0 });
  return { sessions: new Set(records.map(r => r.s)).size, events, memory, ...total, cited_files: citedFilesCount, used_files: usedFilesCount, file_used_rate: citedFilesCount ? usedFilesCount / citedFilesCount : null, used_rate: total.citing ? total.used / total.citing : null, definition: "Item and individual-file coverage by later tools in the same session. Indirect, not causal; maintenance uses bounded captured turns instead." };
}
