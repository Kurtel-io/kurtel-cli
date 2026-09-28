import { appendKnowledge, canonicalJSON, digest, emptyBatch } from "../../storage/knowledge.js";
import type { KnowledgeVersion } from "../../domain/knowledge.js";

export interface RememberInput {
  idempotency_key: string;
  quote: string;
  source_text: string;
  source_reference: string;
  kind: KnowledgeVersion["kind"];
  zones: string[];
}

/** The caller supplies evidence; it is not independently verified human approval. */
export function rememberProposal(root: string, input: RememberInput) {
  if (!input.source_text.includes(input.quote)) throw new Error("quote must occur exactly in source_text");
  const key = digest(input.idempotency_key);
  const sourceId = `mcp:source:${key}`, eventId = `mcp:event:${key}`, id = `mcp:knowledge:${key}:v1`;
  const sourceContent = canonicalJSON({ ...input, provenance: "unverified_mcp_caller" });
  appendKnowledge(root, store => {
    const previous = store.sources.find(s => s.id === sourceId);
    if (previous) {
      if (previous.content !== sourceContent) throw new Error("Idempotency key already used with different content");
      return emptyBatch();
    }
    const now = new Date().toISOString();
    return {
      sources: [{ id: sourceId, kind: "conversation", reference: input.source_reference, revision: null, content: sourceContent, recorded_at: now }],
      events: [{ id: eventId, kind: "proposal", source_ids: [sourceId], actor: "unverified_mcp_caller", session_id: null, occurred_at: null, recorded_at: now, content: input.source_text }],
      versions: [{ id, knowledge_id: `mcp:knowledge:${key}`, version: 1, previous_version_id: null, kind: input.kind, state: "proposed", content: input.quote, zones: input.zones, source_ids: [sourceId], event_ids: [eventId], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null }],
      relations: [],
    };
  });
  return { version_id: id, state: "proposed", source_id: sourceId, event_id: eventId, authority: "unverified_mcp_caller", automatic_promotion: false };
}
