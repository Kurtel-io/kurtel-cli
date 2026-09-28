import { eventKinds, knowledgeKinds, knowledgeStates, relationKinds, type KnowledgeBatch, type KnowledgeEvent, type KnowledgeStore } from "../domain/knowledge.js";

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid knowledge store: ${message}`);
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || text(value);
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

/** What the records being checked may refer to: the records themselves plus what is already stored. */
export interface KnowledgeLookup {
  hasSource(id: string): boolean;
  hasEvent(id: string): boolean;
  hasVersion(id: string): boolean;
  event(id: string): KnowledgeEvent | undefined;
  /** Current last version of a knowledge before these records. */
  head(knowledgeId: string): { id: string; version: number } | undefined;
}

/** Validate disk/import data, including referential integrity and unbranched version chains. */
export function validateKnowledge(value: unknown, scope: string): asserts value is KnowledgeStore {
  requireValue(value && typeof value === "object", "object required");
  const store = value as KnowledgeStore;
  requireValue(store.schema_version === 2 && store.scope === scope, "schema or repository scope mismatch");
  requireValue(Number.isSafeInteger(store.revision) && store.revision >= 0, "revision");
  for (const key of ["sources", "events", "versions", "relations"] as const) requireValue(Array.isArray(store[key]), key);
  const sources = new Set(store.sources.map(s => s.id)), events = new Map(store.events.map(e => [e.id, e])), versions = new Set(store.versions.map(v => v.id));
  validateRecords(store, { hasSource: id => sources.has(id), hasEvent: id => events.has(id), hasVersion: id => versions.has(id), event: id => events.get(id), head: () => undefined });
}

/**
 * Validate records to be added: their fields, what they refer to (among themselves or already stored), and
 * that each new version continues its knowledge's chain. The whole store is never needed.
 */
export function validateRecords(batch: KnowledgeBatch, lookup: KnowledgeLookup): void {
  for (const key of ["sources", "events", "versions", "relations"] as const) {
    requireValue(Array.isArray(batch[key]), key);
    const ids = new Set<string>();
    for (const item of batch[key]) {
      requireValue(item && text(item.id) && date(item.recorded_at), `${key}: id/date`);
      requireValue(!ids.has(item.id), `${key}: duplicate id`);
      ids.add(item.id);
    }
  }
  const refs = (ids: unknown, has: (id: string) => boolean, label: string, required = true) => {
    requireValue(strings(ids) && (!required || ids.length > 0) && ids.every(has), label);
  };
  const interval = (item: { valid_from: string | null; valid_until: string | null }) => {
    requireValue(nullableDate(item.valid_from) && nullableDate(item.valid_until), "validity dates");
    requireValue(!item.valid_from || !item.valid_until || Date.parse(item.valid_from) <= Date.parse(item.valid_until), "validity interval");
  };
  for (const source of batch.sources) {
    if (source.attribution !== undefined) {
      const a = source.attribution;
      requireValue(a && a.provider === "github" && nullableText(a.subject) && nullableText(a.login) && nullableText(a.kurtel_user_id) && nullableDate(a.occurred_at) && text(a.source_type) && nullableText(a.status) && ["github_api_account", "unknown"].includes(a.identity_basis), "source attribution");
    }
    requireValue(["conversation", "commit", "pull_request", "document", "legacy_pattern"].includes(source.kind), "source kind");
    requireValue(text(source.reference) && nullableText(source.revision) && (source.content === null || typeof source.content === "string"), "source payload");
  }
  for (const event of batch.events) {
    requireValue(eventKinds.includes(event.kind) && text(event.content), "event kind/content");
    requireValue(nullableText(event.actor) && nullableText(event.session_id) && nullableDate(event.occurred_at), "event metadata");
    refs(event.source_ids, lookup.hasSource, "event sources");
  }
  const heads = new Map<string, { id: string; version: number } | undefined>();
  for (const version of batch.versions) {
    requireValue(text(version.knowledge_id) && text(version.content) && knowledgeKinds.includes(version.kind) && knowledgeStates.includes(version.state), "knowledge kind/content/state");
    requireValue(strings(version.zones), "knowledge zones");
    requireValue(nullableText(version.legacy_pattern_id) && (version.legacy_score === null || (Number.isFinite(version.legacy_score) && version.legacy_score >= 0 && version.legacy_score <= 1)), "legacy metadata");
    const previous = heads.has(version.knowledge_id) ? heads.get(version.knowledge_id) : lookup.head(version.knowledge_id);
    requireValue(version.version === (previous?.version ?? 0) + 1 && version.previous_version_id === (previous?.id ?? null), "version chain");
    heads.set(version.knowledge_id, version);
    refs(version.source_ids, lookup.hasSource, "knowledge sources");
    refs(version.event_ids, lookup.hasEvent, "knowledge events", false);
    if (version.origin !== undefined) {
      const o = version.origin;
      requireValue(o && nullableText(o.branch) && nullableText(o.commit) && date(o.learned_at), "knowledge origin");
    }
    if (version.kind === "lesson") {
      const lesson = version.lesson;
      requireValue(lesson && lesson.visibility === "local_profile" && nullableText(lesson.author) && text(lesson.session_id), "lesson identity");
      requireValue(lesson.trigger?.task_type === "edit" && strings(lesson.trigger.files) && lesson.trigger.files.length > 0 && lesson.trigger.files.every(f => version.zones.includes(f)) && strings(lesson.trigger.symbols), "lesson trigger");
      for (const proof of [lesson.failure, lesson.approach]) {
        // The quote must come from its event; once captured text is erased (temporary buffer), the event remains.
        const event = lookup.event(proof?.event_id);
        requireValue(proof && text(proof.quote) && proof.quote.length <= 600 && version.event_ids.includes(proof.event_id) && event && event.session_id === lesson.session_id, "lesson quote");
      }
      requireValue(version.content === lesson.approach.quote && ["test_passed", "user_confirmed"].includes(lesson.resolution) && version.event_ids.includes(lesson.success_event_id) && version.event_ids.includes(lesson.error_event_id) && lookup.event(lesson.error_event_id)?.kind === "error_observed", "lesson resolution");
    } else requireValue(version.lesson === undefined, "lesson metadata on non-lesson");
    interval(version);
  }
  for (const relation of batch.relations) {
    requireValue(relationKinds.includes(relation.kind), "relation kind");
    for (const ref of [relation.from, relation.to]) {
      requireValue(ref && text(ref.id), "relation reference");
      const valid = ref.type === "source" ? lookup.hasSource(ref.id) : ref.type === "event" ? lookup.hasEvent(ref.id) : ref.type === "version" ? lookup.hasVersion(ref.id) : ref.type === "code";
      requireValue(valid, "dangling relation");
    }
    refs(relation.source_ids, lookup.hasSource, "relation sources");
    interval(relation);
  }
}
