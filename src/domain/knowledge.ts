import type { LessonDetails } from "./lessons.js";
export const knowledgeKinds = ["convention", "decision", "constraint", "fact", "procedure", "incident", "counterexample", "rejected_alternative", "open_question", "legacy_pattern", "lesson"] as const;
export const eventKinds = ["instruction", "proposal", "acceptance", "action_attempted", "outcome_verified", "observation", "error_observed", "legacy_import"] as const;
export const relationKinds = ["applies_to", "motivated_by", "supported_by", "contradicts", "supersedes", "exception_to", "alternative_to", "read_with"] as const;
export const knowledgeStates = ["proposed", "active", "contested", "superseded", "archived"] as const;

export interface SourceAttribution {
  provider: "github"; subject: string | null; login: string | null; kurtel_user_id: string | null;
  occurred_at: string | null; source_type: string; status: string | null; identity_basis: "github_api_account" | "unknown";
}
export interface Source {
  attribution?: SourceAttribution;
  id: string;
  kind: "conversation" | "commit" | "pull_request" | "document" | "legacy_pattern";
  reference: string;
  revision: string | null;
  content: string | null;
  recorded_at: string;
}

export interface KnowledgeEvent {
  id: string;
  kind: typeof eventKinds[number];
  source_ids: string[];
  actor: string | null;
  session_id: string | null;
  occurred_at: string | null;
  recorded_at: string;
  content: string;
}

export interface KnowledgeOrigin { branch: string | null; commit: string | null; learned_at: string }

export interface KnowledgeVersion {
  lesson?: LessonDetails;
  /** Where a teammate learned it (shared knowledge); local knowledge derives it from its capture. */
  origin?: KnowledgeOrigin;
  id: string;
  knowledge_id: string;
  version: number;
  previous_version_id: string | null;
  kind: typeof knowledgeKinds[number];
  state: typeof knowledgeStates[number];
  content: string;
  zones: string[];
  source_ids: string[];
  event_ids: string[];
  recorded_at: string;
  valid_from: string | null;
  valid_until: string | null;
  legacy_pattern_id: string | null;
  legacy_score: number | null;
}

export type KnowledgeRef = { type: "version" | "source" | "event" | "code"; id: string };
export interface KnowledgeRelation {
  id: string;
  kind: typeof relationKinds[number];
  from: KnowledgeRef;
  to: KnowledgeRef;
  source_ids: string[];
  recorded_at: string;
  valid_from: string | null;
  valid_until: string | null;
}

export interface KnowledgeBatch {
  sources: Source[];
  events: KnowledgeEvent[];
  versions: KnowledgeVersion[];
  relations: KnowledgeRelation[];
}

export interface KnowledgeStore extends KnowledgeBatch {
  schema_version: 2;
  scope: string;
  revision: number;
}

/** How a version is cited in what an agent reads: eight characters of its hash instead of sixty-four. Other ids stay whole. */
export function memoryRef(id: string): string {
  return /^version:[0-9a-f]{64}$/.test(id) ? id.slice(8, 16) : id;
}
