import { policyFetch } from "../security/network.js";
import type { CodebaseIndex } from "../domain/types.js";
import type { KnowledgeStore, KnowledgeVersion } from "../domain/knowledge.js";
import { digest, memoryRevisionOf, readKnowledgeFor } from "../storage/knowledge.js";
import { semanticMatches } from "./knowledge-vectors.js";
import { indexRevision } from "../storage/graph-index.js";
import { engineTarget, noticeMemoryRefusal, sameEngine } from "../memory/engine.js";
import { evaluationRequestFromStore } from "../memory/darwinian.js";
import { kurtelEnabled, memoryEnabled, repoActivated } from "../storage/state.js";
import { tokenize } from "./tokenize.js";
import { embedTokens, cosine } from "./embeddings.js";
import { navigationScope } from "./navigation.js";
import { codeTranslations } from "./translate.js";
import { resolveZones } from "./ranking.js";
import { packContext, type ContextItem } from "./budget.js";
import { maintenanceFacts } from "../memory/maintenance.js";
import { codeObservations } from "../storage/code-observations.js";
import { teamContext } from "../memory/team.js";
import { suspendedVersions } from "../memory/automatic.js";
import { hiddenVersions } from "../memory/visibility.js";

export type ContextMode = "action" | "investigation";
/** explicit: paths given or cited; inferred: deduced from the graph; none: unknown. */
export type ScopeSource = "explicit" | "inferred" | "none";
interface Assessment { version_id: string; eligible: boolean; reasons: string[]; rank: number }
export interface CompactOptions { paths?: string[]; mode?: ContextMode; budget?: number; graphOnly?: boolean; memoryOnly?: boolean; session?: string }

// Minimum relevance: below it, inject nothing.
export const MIN_MEMORY_RELEVANCE = 0.35;
// Scope-only reasons: they never invalidate earlier deliveries.
const SCOPE_REASONS = new Set(["out_of_scope", "task_scope_unknown", "context_capacity", "exploration_limit", "current_active_in_scope", "inferred_scope", "not_hard_pre_edit"]);
const INFORMATIVE_REASONS = new Set(["current_active_in_scope", "inferred_scope"]);
// Open questions never hold an edit.
const NEVER_PRE_EDIT = new Set(["open_question"]);


/** One actionable sentence; long prose stays in investigation mode. */
function firstSentence(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.slice(40).search(/[.!?](\s|$)/);
  const sentence = end >= 0 && end + 41 <= max ? flat.slice(0, end + 41) : flat;
  return sentence.length > max ? sentence.slice(0, max - 1) + "…" : sentence;
}

export async function compactContext(root: string, index: CodebaseIndex | null, prompt: string, options: CompactOptions = {}) {
  const mode = options.mode ?? "action";
  if (!["action", "investigation"].includes(mode)) throw new Error("Invalid context mode");
  const explicitPaths = [...new Set(options.paths ?? (prompt.match(/(?<![\w/.:])(?:[\w@.-]+\/)+[\w.-]+/g) ?? []))].slice(0, 50);
  if (explicitPaths.some(p => p.startsWith("/") || p.includes("\\") || p.split("/").includes("..") || p.includes(":"))) throw new Error("Context paths must be repository-relative");
  const items: ContextItem[] = [], warnings: string[] = [], ineligible = new Set<string>();
  let unavailable = false;
  let teamRevision = "none";
  const teamKeys = new Set<string>();
  const stillValid = (key: string) => {
    if (key.startsWith("team:")) return teamKeys.has(key);
    if (!key.startsWith("memory:")) return true;
    const versionId = /^memory:(?:action|investigation):(.+):[^:]+$/.exec(key)?.[1] ?? key.split(":")[2];
    return !unavailable && !ineligible.has(versionId);
  };
  const inactive = { items, warnings: ["repository_inactive"], revision: 0 as string | number, mode, paths: explicitPaths, scope: "none" as ScopeSource, zones: [] as string[], stillValid };
  // The graph needs Kurtel on; knowledge also needs memory.
  if (!repoActivated(root) || !kurtelEnabled(root) || (options.memoryOnly && !memoryEnabled(root))) return { ...packContext([], options.budget), ...inactive };
  const query = tokenize(prompt);
  const zones = index ? resolveZones(index, query) : [];
  const navigation = index ? navigationScope(index, prompt, (words, vocabulary) => codeTranslations(root, words, vocabulary)) : { lines: [], files: [] };
  // No cited path: the graph's definitions give an inferred scope.
  const paths = explicitPaths.length ? explicitPaths : navigation.files.slice(0, 5);
  const scope: ScopeSource = explicitPaths.length ? "explicit" : paths.length ? "inferred" : "none";
  const graphRevision = index ? indexRevision(root, index) : "";
  if (!options.memoryOnly) {
    // Keep sections whole under the budget.
    let section: string[] = [];
    const addSection = () => {
      if (section.length < 2) return;
      let group: string[] = [];
      const addGroup = () => {
        if (!group.length) return;
        const text = [section[0], ...group].join("\n");
        items.push({ key: `graph:${graphRevision}:${digest(text)}`, text, priority: items.length === 0 ? 80 : 40 - items.length * .001 });
      };
      for (const line of section.slice(1)) {
        if (line.startsWith("- ")) { addGroup(); group = []; }
        group.push(line);
      }
      addGroup();
    };
    for (const line of navigation.lines) {
      if (!line.startsWith(" ") && !line.startsWith("-")) { addSection(); section = []; }
      section.push(line);
    }
    addSection();
  }
  const done = (revision: string | number) => {
    // One ceiling for shared and personal memories.
    if (mode === "action" && teamKeys.size) {
      const memory = items.filter(i => /^(memory|team):/.test(i.key)).sort((a, b) => b.priority - a.priority);
      const omitted = new Set(memory.slice(4).map(i => i.key));
      for (let i = items.length - 1; i >= 0; i--) if (omitted.has(items[i].key)) items.splice(i, 1);
    }
    return { ...packContext(items, options.budget), items, warnings, revision: teamRevision === "none" ? revision : `${revision}:team:${teamRevision}`, mode, paths, scope, zones, stillValid };
  };
  if (options.graphOnly || !memoryEnabled(root)) return done(0);
  try {
    // Sends explicit paths only, never prompts or conversations.
    const shared = await teamContext(root, explicitPaths, mode, !!options.memoryOnly);
    teamRevision = shared.revision;
    for (const item of shared.items) { items.push(item); teamKeys.add(item.key); }
  } catch { teamRevision = "unavailable"; warnings.push("team_memory_unavailable"); }
  let target;
  try { target = engineTarget(root, "context"); }
  catch { warnings.push("memory_configuration_unreadable"); return done(0); }
  // No engine: graph only.
  if (!target) return done(0);
  let revision: string | number = 0;
  try {
    revision = memoryRevisionOf(root);
    // Reads only what may concern the task (its files, repository-wide constraints, word and meaning matches, cited
    // versions, the session), so the cost does not grow with the store.
    const close = options.memoryOnly ? [] : semanticMatches(root, query);
    const cited = prompt.match(/[\w-]+:[\w:.-]+/g) ?? [];
    const store = readKnowledgeFor(root, { paths, words: options.memoryOnly ? [] : query, knowledgeIds: close, versionIds: cited, session: options.session, depth: mode === "investigation" ? 3 : 1 });
    const latest = new Map<string, number>();
    for (const v of store.versions) latest.set(v.knowledge_id, Math.max(latest.get(v.knowledge_id) ?? 0, v.version));
    const now = Date.now();
    for (const v of store.versions) if (v.valid_until && Date.parse(v.valid_until) <= now) ineligible.add(v.id);
    // Hold back what the turn being judged produced.
    const suspended = suspendedVersions(root, options.session, store);
    // Hide knowledge from branches whose code is not here.
    for (const id of hiddenVersions(root, store)) suspended.add(id);
    const q = embedTokens(query);
    // Narrowest matching zone wins: src/http outranks src.
    const scopeDepth = (v: KnowledgeVersion) => Math.max(0, ...v.zones.filter(z => paths.some(p => p === z || p.startsWith(z + "/"))).map(z => z.split("/").length));
    let candidates = store.versions.filter(v => (mode === "investigation" || v.version === latest.get(v.knowledge_id)) && !suspended.has(v.id) && (!options.memoryOnly || !NEVER_PRE_EDIT.has(v.kind))).map(v => {
      const words = tokenize(v.content), hits = options.memoryOnly ? 0 : query.filter(t => words.includes(t)).length;
      const vector = q && !options.memoryOnly ? embedTokens(words) : null;
      const semantic = q && vector ? cosine(q, vector) : 0;
      const depth = scopeDepth(v), scoped = depth > 0;
      const exact = prompt.includes(v.id);
      // Before an edit, only file-scoped rules may hold it.
      const globalConstraint = !v.zones.length && v.kind === "constraint" && paths.length > 0 && !options.memoryOnly;
      const inferred = scope === "inferred";
      const relevance = exact ? 1 : Math.min(1, (scoped ? (inferred ? .35 : .5) + .03 * Math.min(depth - 1, 5) : globalConstraint ? (inferred ? .25 : .4) : 0) + hits / Math.max(1, query.length) * .5 + (semantic >= .65 ? semantic * .3 : 0));
      const relevant = exact || scoped || (globalConstraint && !inferred) || hits >= 2 || (hits > 0 && query.length === 1) || semantic >= .65;
      return { v, relevance, relevant: relevant && (exact || relevance >= MIN_MEMORY_RELEVANCE) };
    }).filter(c => c.relevant).sort((a, b) => b.relevance - a.relevance || a.v.id.localeCompare(b.v.id));
    // The engine does the final ranking.
    candidates = candidates.slice(0, 8);
    if (mode === "investigation") {
      const ids = new Set(candidates.map(c => c.v.id));
      for (let depth = 0; depth < 3 && candidates.length < 12; depth++) {
        for (const r of store.relations) {
          if (!["motivated_by", "alternative_to", "contradicts", "exception_to"].includes(r.kind) || r.from.type !== "version" || r.to.type !== "version") continue;
          const target = ids.has(r.from.id) ? r.to.id : ids.has(r.to.id) ? r.from.id : null;
          const v = store.versions.find(v => v.id === target);
          if (v && !ids.has(v.id) && candidates.length < 12) { ids.add(v.id); candidates.push({ v, relevance: .3, relevant: true }); }
        }
      }
    }
    if (candidates.length) {
      const at = new Date().toISOString();
      const observedCode = codeObservations(root, index, candidates.flatMap(c => c.v.zones));
      const body = JSON.stringify({ protocol: 1, ...(options.memoryOnly ? { phase: "pre_edit" } : {}), candidates: candidates.map(c => ({ relevance: c.relevance, request: { ...evaluationRequestFromStore(store, c.v.id, paths, mode, at), maintenance: maintenanceFacts(root, store, c.v, index, at, observedCode), path_source: scope === "inferred" ? "inferred" : "explicit" } })), ...target.where });
      if (Buffer.byteLength(body) > 400000) throw new Error("context_request_too_large");
      const response = await policyFetch(target.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2500), headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` }, body }, target.purpose);
      if (!response.ok) { await noticeMemoryRefusal(root, target, response); throw new Error(`engine_http_${response.status}`); }
      const result = await response.json() as { protocol: number; evaluations: Assessment[] };
      if (result.protocol !== 1 || !Array.isArray(result.evaluations) || result.evaluations.length !== candidates.length) throw new Error("invalid_context_response");
      const ids = new Set<string>();
      for (const a of result.evaluations) {
        if (!candidates.some(c => c.v.id === a.version_id) || ids.has(a.version_id) || typeof a.eligible !== "boolean" || !Number.isFinite(a.rank) || !Array.isArray(a.reasons) || !a.reasons.every(r => typeof r === "string")) throw new Error("invalid_context_assessment");
        ids.add(a.version_id);
      }
      if (memoryRevisionOf(root) !== revision || !memoryEnabled(root) || !repoActivated(root) || !sameEngine(root, "context", target)) throw new Error("context_changed_during_request");
      for (const a of result.evaluations) {
        if (!a.eligible) {
          warnings.push(`${a.version_id}: ${a.reasons.join(", ")}`);
          if (!a.reasons.every(r => SCOPE_REASONS.has(r))) ineligible.add(a.version_id);
          continue;
        }
        const v = candidates.find(c => c.v.id === a.version_id)!.v;
        const sources = v.source_ids.map(id => store.sources.find(s => s.id === id)).filter(s => !!s).slice(0, 2).map(s => `${s.id} (${s.reference}${s.revision ? ` @ ${s.revision}` : ""})`);
        let text: string;
        if (mode === "action") {
          const notes = a.reasons.filter(r => !INFORMATIVE_REASONS.has(r));
          const where = v.zones.join(", ") || "repository";
          // Short source pointer; `kurtel knowledge why <id>` has the full provenance.
          const source = store.sources.find(s => s.id === v.source_ids[0]);
          const brief = source ? `${source.kind} ${source.reference.length > 48 ? "…" + source.reference.slice(-47) : source.reference}` : "missing";
          // Provenance, not approval.
          const corrected = v.event_ids.some(id => id.startsWith("correction:")), teammate = source?.id.startsWith("shared:");
          const origin = teammate ? (corrected ? "stated by a teammate when correcting their agent" : "shared by a teammate, observed in their session, not an approval")
            : corrected ? "stated by the user when correcting the agent" : "observed in a past session, not an approval";
          text = `- ${v.kind}${notes.length ? ` [${notes.join(", ")}]` : ""}: ${firstSentence(v.content)}\n  Applies to ${where}${scope === "inferred" ? " (task scope inferred from the code graph — check it matches)" : ""}. Origin: ${origin}. Source: ${brief}. Memory ${v.id}.`;
        } else {
          const relations = store.relations.filter(r => r.from.type === "version" && r.from.id === v.id).slice(0, 4).map(r => `${r.kind} → ${r.to.id} [${r.id}; sources ${r.source_ids.join(", ")}]`);
          text = `Memory ${v.id} [${mode}; ${v.kind}; ${v.state}; ${a.reasons.join(", ")}]:\n${v.content}\nScope: ${v.zones.join(", ") || "repository"}; assessed only for ${scope === "inferred" ? "inferred " : ""}task paths: ${paths.join(", ") || "unknown"}. Reassess for other paths.\nSources: ${sources.join("; ") || "missing"}${relations.length ? `\nRecorded relations (may be historical): ${relations.join("; ")}` : ""}`;
        }
        items.push({ key: `memory:${mode}:${v.id}:${digest(text)}`, text, priority: 50 + a.rank, files: v.zones.length ? v.zones : paths });
      }
    }
  } catch (error) { unavailable = true; warnings.push(`memory_unavailable: ${error instanceof Error ? error.message : "unknown"}`); }
  return done(revision);
}
