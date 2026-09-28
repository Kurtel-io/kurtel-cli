import { appendKnowledge, canonicalJSON, digest, emptyBatch } from "../storage/knowledge.js";

export interface DecisionTrace {
  key: string;
  source_id: string;
  decision_quote: string;
  reason_quote?: string;
  motivated_by?: string[];
  alternatives?: { source_id: string; quote: string }[];
  event_ids?: string[];
  paths: string[];
}

/** Records a sourced proposal, never retroactively asserts approval or observed model causality. */
export function recordDecisionTrace(root: string, input: DecisionTrace) {
  if (!input.key?.trim() || input.key.length > 200 || !input.decision_quote?.trim() || input.decision_quote.length > 1200 || (input.reason_quote?.length ?? 0) > 1200 || !Array.isArray(input.paths) || input.paths.length > 20 || input.paths.some(p => !p || p.startsWith("/") || p.includes(":") || p.includes("\\") || p.split("/").includes("..")) || (input.motivated_by?.length ?? 0) > 8 || (input.alternatives?.length ?? 0) > 8 || (input.event_ids?.length ?? 0) > 20) throw new Error("Invalid decision trace");
  const id = `trace:${digest(input.key)}`, fingerprint = canonicalJSON(input);
  appendKnowledge(root, store => {
    const previous = store.events.find(e => e.id === `${id}:proposal`);
    if (previous) { if (previous.content !== fingerprint) throw new Error("Decision key reused with different content"); return emptyBatch(); }
    const source = store.sources.find(s => s.id === input.source_id);
    if (!source?.content?.includes(input.decision_quote) || (input.reason_quote && !source.content.includes(input.reason_quote))) throw new Error("Decision and reason must be exact quotes from the recorded source");
    const eventIds = input.event_ids ?? [];
    for (const eventId of eventIds) if (!store.events.some(e => e.id === eventId)) throw new Error("Unknown observed event");
    for (const parent of input.motivated_by ?? []) if (!store.versions.some(v => v.id === parent)) throw new Error("Unknown cited knowledge version");
    for (const a of input.alternatives ?? []) if (!a.quote?.trim() || a.quote.length > 1200 || !store.sources.find(s => s.id === a.source_id)?.content?.includes(a.quote)) throw new Error("Alternative must quote a recorded source");
    const now = new Date().toISOString(), batch = emptyBatch();
    const version = (suffix: string, content: string, kind: "decision" | "rejected_alternative", sourceId: string) => ({ id: `${id}:${suffix}:v1`, knowledge_id: `${id}:${suffix}`, version: 1, previous_version_id: null, kind, state: "proposed" as const, content, zones: input.paths, source_ids: [sourceId], event_ids: [`${id}:proposal`, ...eventIds], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null });
    const relation = (suffix: string, kind: "motivated_by" | "alternative_to", to: { type: "version" | "event"; id: string }, sourceId: string) => ({ id: `${id}:${suffix}`, kind, from: { type: "version" as const, id: `${id}:decision:v1` }, to, source_ids: [sourceId], recorded_at: now, valid_from: null, valid_until: null });
    batch.events.push({ id: `${id}:proposal`, kind: "proposal", actor: "decision_trace_caller", source_ids: [source.id], session_id: null, occurred_at: null, recorded_at: now, content: fingerprint });
    batch.versions.push(version("decision", input.decision_quote, "decision", source.id));
    if (input.reason_quote) {
      batch.events.push({ id: `${id}:reason`, kind: "observation", actor: source.attribution?.subject ? `github:${source.attribution.subject}` : null, source_ids: [source.id], session_id: null, occurred_at: source.attribution?.occurred_at ?? null, recorded_at: now, content: input.reason_quote });
      batch.relations.push(relation("reason-link", "motivated_by", { type: "event", id: `${id}:reason` }, source.id));
    }
    for (const [n, parent] of (input.motivated_by ?? []).entries()) batch.relations.push(relation(`parent:${n}`, "motivated_by", { type: "version", id: parent }, source.id));
    for (const [n, alt] of (input.alternatives ?? []).entries()) { const v = version(`alternative:${n}`, alt.quote, "rejected_alternative", alt.source_id); batch.versions.push(v); batch.relations.push(relation(`alternative-link:${n}`, "alternative_to", { type: "version", id: v.id }, alt.source_id)); }
    return batch;
  });
  return { version_id: `${id}:decision:v1`, state: "proposed", authority: "caller_reported_causal_link", automatic_approval: false };
}
