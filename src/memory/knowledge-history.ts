import type { KnowledgeStore, KnowledgeVersion, KnowledgeRelation, KnowledgeRef } from "../domain/knowledge.js";

export function queryTime(at?: string): number {
  const time = at === undefined ? Date.now() : Date.parse(at);
  if (!Number.isFinite(time)) throw new Error("Invalid --at date; use an ISO timestamp");
  return time;
}

export function headsAt(store: KnowledgeStore, time: number): KnowledgeVersion[] {
  const heads = new Map<string, KnowledgeVersion>();
  for (const version of store.versions) {
    if (Date.parse(version.recorded_at) <= time) heads.set(version.knowledge_id, version);
  }
  return [...heads.values()];
}

export function validAt(item: { valid_from: string | null; valid_until: string | null }, time: number): boolean {
  return (!item.valid_from || Date.parse(item.valid_from) <= time) && (!item.valid_until || time < Date.parse(item.valid_until));
}

const words = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const stop = new Set(["pourquoi", "why", "on", "a", "le", "la", "les", "de", "des", "du", "ce", "cette", "choisi", "utilise", "the", "did", "we", "use", "decision", "decide", "est", "un", "une", "do", "how", "was", "it", "is"]);

export function resolveKnowledge(store: KnowledgeStore, query: string, time: number): KnowledgeVersion[] {
  if (!query.trim()) throw new Error("A knowledge ID, version ID or search phrase is required");
  const exactVersion = store.versions.find(v => v.id === query && Date.parse(v.recorded_at) <= time);
  if (exactVersion) return [exactVersion];
  const heads = headsAt(store, time);
  const exact = heads.find(v => v.knowledge_id === query);
  if (exact) return [exact];
  const tokens = [...new Set(words(query).filter(word => !stop.has(word)))];
  if (!tokens.length) return [];
  return heads.filter(version => {
    const terms = new Set(words(`${version.knowledge_id} ${version.content} ${version.zones.join(" ")}`));
    return tokens.every(token => terms.has(token));
  });
}

export function knowledgeHistory(store: KnowledgeStore, query: string, at?: string) {
  const time = queryTime(at);
  const candidates = resolveKnowledge(store, query, time);
  if (candidates.length !== 1) return { status: candidates.length ? "ambiguous" : "not_found", candidates };
  const versions = store.versions.filter(v => v.knowledge_id === candidates[0].knowledge_id && Date.parse(v.recorded_at) <= time);
  const ids = new Set(versions.map(v => v.id));
  const relations = store.relations.filter(r => Date.parse(r.recorded_at) <= time && ((r.from.type === "version" && ids.has(r.from.id)) || (r.to.type === "version" && ids.has(r.to.id))));
  const eventIds = new Set(versions.flatMap(v => v.event_ids));
  for (const relation of relations) for (const ref of [relation.from, relation.to]) if (ref.type === "event") eventIds.add(ref.id);
  const events = store.events.filter(e => eventIds.has(e.id) && Date.parse(e.recorded_at) <= time);
  const sourceIds = new Set([...versions.flatMap(v => v.source_ids), ...relations.flatMap(r => r.source_ids), ...events.flatMap(e => e.source_ids)]);
  for (const relation of relations) for (const ref of [relation.from, relation.to]) if (ref.type === "source") sourceIds.add(ref.id);
  return { status: "found", knowledge_id: candidates[0].knowledge_id, versions, events, relations, sources: store.sources.filter(s => sourceIds.has(s.id) && Date.parse(s.recorded_at) <= time) };
}

export function explainKnowledge(store: KnowledgeStore, query: string, options: { at?: string; depth?: number } = {}) {
  const time = queryTime(options.at);
  const depth = options.depth ?? 6;
  if (!Number.isInteger(depth) || depth < 1 || depth > 20) throw new Error("Depth must be between 1 and 20");
  const candidates = resolveKnowledge(store, query, time);
  if (candidates.length !== 1) return { status: candidates.length ? "ambiguous" : "not_found", candidates };
  const selected = candidates[0];
  const versions = new Map(store.versions.map(v => [v.id, v]));
  const events = new Map(store.events.map(e => [e.id, e]));
  const sources = new Map(store.sources.map(s => [s.id, s]));
  const currentHeads = new Map(headsAt(store, time).map(v => [v.knowledge_id, v.id]));
  const sourceIds = new Set(selected.source_ids);
  for (const id of selected.event_ids) for (const source of events.get(id)?.source_ids ?? []) sourceIds.add(source);
  const visible = (ref: KnowledgeRef) => {
    const record = ref.type === "version" ? versions.get(ref.id) : ref.type === "event" ? events.get(ref.id) : sources.get(ref.id);
    return ref.type === "code" || (record && Date.parse(record.recorded_at) <= time);
  };
  const relations = store.relations.filter(r => Date.parse(r.recorded_at) <= time && validAt(r, time) && visible(r.from) && visible(r.to) && r.source_ids.every(id => visible({ type: "source", id })));
  const describe = (ref: KnowledgeRef) => {
    const record = ref.type === "version" ? versions.get(ref.id) : ref.type === "event" ? events.get(ref.id) : ref.type === "source" ? sources.get(ref.id) : undefined;
    if (ref.type === "source") sourceIds.add(ref.id);
    if (record && "source_ids" in record) for (const id of record.source_ids) sourceIds.add(id);
    const version = ref.type === "version" ? versions.get(ref.id) : undefined;
    return { ...ref, record: record ?? null,
      attribution: ref.type === "source" ? sources.get(ref.id)?.attribution ?? null : record && "source_ids" in record ? record.source_ids.map(id => ({ source_id: id, reference: sources.get(id)?.reference, attribution: sources.get(id)?.attribution ?? null })) : null,
      historical_version: version ? currentHeads.get(version.knowledge_id) !== version.id : false,
      valid_at_query_time: version ? validAt(version, time) : null,
    };
  };
  const proof = (relation: KnowledgeRelation) => {
    for (const id of relation.source_ids) sourceIds.add(id);
    return { relation, from: describe(relation.from), to: describe(relation.to) };
  };
  const reasons: ReturnType<typeof proof>[] = [];
  const cycles: string[] = [];
  let truncated = false;
  const used = new Set<string>();
  const expanded = new Map<string, number>();
  const walk = (id: string, level: number, path: Set<string>) => {
    if ((expanded.get(id) ?? Infinity) <= level) return;
    expanded.set(id, level);
    const edges = relations.filter(r => r.kind === "motivated_by" && r.from.type === "version" && r.from.id === id);
    if (level >= depth) { if (edges.length) truncated = true; return; }
    for (const edge of edges) {
      if (reasons.length >= 100) { truncated = true; return; }
      if (!used.has(edge.id)) { reasons.push(proof(edge)); used.add(edge.id); }
      if (edge.to.type === "version") {
        if (path.has(edge.to.id)) { cycles.push(edge.id); continue; }
        walk(edge.to.id, level + 1, new Set([...path, edge.to.id]));
      }
    }
  };
  walk(selected.id, 0, new Set([selected.id]));
  const related = relations.filter(r => (r.from.type === "version" && r.from.id === selected.id) || (r.to.type === "version" && r.to.id === selected.id));
  const evidence = related.filter(r => r.kind === "supported_by").map(proof);
  const counterexamples = related.filter(r => r.kind === "contradicts" || r.kind === "exception_to").map(proof);
  const alternatives = related.filter(r => r.kind === "alternative_to").map(proof);
  const replacements = related.filter(r => r.kind === "supersedes").map(proof);
  const head = headsAt(store, time).find(v => v.knowledge_id === selected.knowledge_id);
  return {
    status: reasons.length ? "explained" : "missing_reason", selected,
    attribution: selected.source_ids.map(id => ({ source_id: id, reference: sources.get(id)?.reference, attribution: sources.get(id)?.attribution ?? null })),
    events: store.events.filter(e => selected.event_ids.includes(e.id) && Date.parse(e.recorded_at) <= time),
    causal_claim: selected.id.startsWith("trace:") ? "caller_reported_not_independently_verified" : "recorded_relationship",
    current_version_id: head?.id ?? null, historical_version: head?.id !== selected.id,
    valid_at_query_time: validAt(selected, time), reasons, evidence, alternatives, counterexamples, replacements,
    cycles: [...new Set(cycles)], truncated,
    sources: store.sources.filter(s => sourceIds.has(s.id) && Date.parse(s.recorded_at) <= time),
    limitation: "Only explicitly recorded relationships are reported. Sources establish provenance, not independent verification. Legacy states are historical observations, not current server availability.",
  };
}
