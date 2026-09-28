import type { KnowledgeStore } from "../domain/knowledge.js";
import { readKnowledge } from "../storage/knowledge.js";
import { maintenanceFacts } from "./maintenance.js";
import { loadIndex } from "../storage/graph-index.js";

export function evaluationRequest(root: string, versionId: string, paths: string[], mode = "action", at?: string) {
  const store = readKnowledge(root);
  const when = at ?? new Date().toISOString();
  const request = evaluationRequestFromStore(store, versionId, paths, mode, when);
  return { ...request, maintenance: maintenanceFacts(root, store, store.versions.find(v => v.id === versionId)!, loadIndex(root), when, undefined, at === undefined) };
}

/** Reuse one validated snapshot across a context batch; callers still check its revision after HTTP. */
export function evaluationRequestFromStore(store: KnowledgeStore, versionId: string, paths: string[], mode = "action", at = new Date().toISOString()) {
  if (!["action", "investigation"].includes(mode) || !Number.isFinite(Date.parse(at))) throw new Error("Invalid evaluation mode/date");
  const selected = store.versions.find(v => v.id === versionId);
  if (!selected) throw new Error("Provide an exact version ID");
  const related = store.relations.filter(r => (r.from.type === "version" && r.from.id === versionId) || (r.to.type === "version" && r.to.id === versionId));
  const ids = new Set([versionId, ...related.flatMap(r => [r.from, r.to]).filter(r => r.type === "version").map(r => r.id)]);
  const families = new Set(store.versions.filter(v => ids.has(v.id)).map(v => v.knowledge_id));
  const versions = store.versions.filter(v => families.has(v.knowledge_id));
  const eventIds = new Set(versions.flatMap(v => v.event_ids));
  const events = store.events.filter(e => {
    if (eventIds.has(e.id)) return true;
    try {
      const f = JSON.parse(e.content);
      return (f.protocol === "kurtel-feedback-v1" && ids.has(f.version_id)) || (f.protocol === "kurtel-confirmation-v1" && families.has(f.knowledge_id));
    } catch { return false; }
  });
  const relevantEvents = new Set(events.map(e => e.id)), relevantRelations = new Set(related.map(r => r.id));
  for (const e of store.events) {
    try {
      const data = JSON.parse(e.content);
      if ((data.protocol === "kurtel-feedback-retraction-v1" && relevantEvents.has(data.event_id)) || (data.protocol === "kurtel-relation-resolution-v1" && relevantRelations.has(data.relation_id))) events.push(e);
    } catch { /* Non-feedback event. */ }
  }
  const sourceIds = new Set([...versions.flatMap(v => v.source_ids), ...related.flatMap(r => r.source_ids), ...events.flatMap(e => e.source_ids)]);
  return { protocol: 1, version_id: versionId, paths, mode, at, store: {
    versions: versions.map(v => { const { lesson: _privateLesson, ...metadata } = v; return { ...metadata, content: "" }; }), relations: related,
    sources: store.sources.filter(s => sourceIds.has(s.id)).map(s => ({ ...s, content: null })),
    events: events.map(e => {
      let content = "";
      try {
        const data = JSON.parse(e.content);
        // Automatic-memory events carry identifiers and file scopes only, never message text.
        if (["kurtel-feedback-v1", "kurtel-feedback-retraction-v1", "kurtel-relation-resolution-v1", "kurtel-confirmation-v1", "kurtel-correction-v1"].includes(data.protocol)) { delete data.note; content = JSON.stringify(data); }
      } catch { /* Do not send conversation text for scoring. */ }
      return { ...e, actor: null, content };
    }),
  } };
}
