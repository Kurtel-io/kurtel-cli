import { appendKnowledge, canonicalJSON, digest, emptyBatch, readKnowledge } from "../storage/knowledge.js";
import type { Source } from "../domain/knowledge.js";
import { loadConfig, apiUrl } from "../lib/config.js";
import { policyFetch } from "../security/network.js";

export function searchDecisionSources(root: string, query: string, offset = 0) {
  if (!query.trim() || query.length > 4000 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid source query");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = readKnowledge(root).sources.filter(s => s.attribution?.provider === "github" && (s.id === query || words.every(w => `${s.content ?? ""} ${s.reference}`.toLowerCase().includes(w))));
  return { records: matches.slice(offset, offset + 3).map(s => {
    const text = s.content ?? "", position = Math.max(0, text.toLowerCase().indexOf(words[0]));
    const start = Math.max(0, position - 100);
    return { id: s.id, reference: s.reference, revision: s.revision, attribution: s.attribution, excerpt: text.slice(start, start + 1800), excerpt_offset: start, truncated: start > 0 || text.length > start + 1800 };
  }), next_offset: offset + 3 < matches.length ? offset + 3 : null, total: matches.length, limitation: "Recorded snapshots, not live GitHub state. An authored statement is not proof of who approved a decision." };
}

export function importDecisionSources(root: string, page: any) {
  if (page?.protocol !== 1 || !/^[A-Za-z0-9_][\w.-]*\/[A-Za-z0-9_][\w.-]*$/.test(page.repo ?? "") || !Array.isArray(page.records) || page.records.length > 30) throw new Error("Invalid source page");
  return appendKnowledge(root, store => {
    const batch = emptyBatch(), now = new Date().toISOString();
    for (const record of page.records) {
      if (!["commit", "pull_request", "document"].includes(record.kind) || typeof record.reference !== "string" || !record.reference.startsWith(`https://github.com/${page.repo}/`) || typeof record.content !== "string" || record.content.length > 100000 || typeof record.revision !== "string") throw new Error("Invalid GitHub source");
      const payload = { kind: record.kind, reference: record.reference, revision: record.revision, content: record.content, attribution: record.attribution };
      const id = `github:${digest(canonicalJSON(payload))}`;
      if (store.sources.some(s => s.id === id) || batch.sources.some(s => s.id === id)) continue;
      batch.sources.push({ ...payload, id, recorded_at: now } as Source);
      batch.events.push({ id: `${id}:observed`, kind: "observation", source_ids: [id], actor: record.attribution?.subject ? `github:${record.attribution.subject}` : null, session_id: null, occurred_at: record.attribution?.occurred_at ?? null, recorded_at: now, content: `Imported ${record.attribution?.source_type ?? record.kind}; authorship is not approval.` });
    }
    return batch;
  });
}

export async function fetchDecisionSources(root: string, input: { repo: string; kind: string; ref?: string; path?: string; page?: number }) {
  const config = loadConfig(); if (!config.loggedIn || !config.token) throw new Error("Use kurtel login first");
  const url = new URL(`${apiUrl()}/api/github/history`);
  for (const [key, value] of Object.entries(input)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await policyFetch(url, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(25000) }, "cloud");
  if (!response.ok) throw new Error(`github_history_http_${response.status}`);
  const raw = await response.text(); if (raw.length > 4000000) throw new Error("Source page too large");
  const page = JSON.parse(raw);
  if (page.repo !== input.repo) throw new Error("Repository mismatch");
  const store = importDecisionSources(root, page);
  return { revision: store.revision, next_page: page.next_page, completeness: page.completeness, sources: page.records.length };
}
