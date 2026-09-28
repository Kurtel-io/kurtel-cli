// Automatic memory: knowledge is active by default, confirmed when it serves without a correction, contested
// when a correction contradicts it. Without a classification, nothing is stored.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { KnowledgeEvent, KnowledgeStore, KnowledgeVersion, Source } from "../domain/knowledge.js";
import { appendKnowledge, digest, emptyBatch, knowledgePath, readKnowledge, readKnowledgeFor } from "../storage/knowledge.js";
import { injectedMemories, sessionKey } from "../storage/usage.js";
import { ingestSession, sessionCaptureEnabled } from "../integrations/session-capture.js";
import { engineTarget, noticeMemoryRefusal } from "./engine.js";
import { purgeCaptureText } from "./capture-retention.js";
import { syncShared } from "./shared.js";
import { backgroundUpkeep } from "./upkeep.js";
import { memoryEnabled, repoActivated } from "../storage/state.js";
import { policyFetch } from "../security/network.js";

export const CONFIRMATION = "kurtel-confirmation-v1", CORRECTION = "kurtel-correction-v1", WITHHELD = "kurtel-withheld-v1", SETTLED = "kurtel-turn-settled-v1";
export const CORRECTION_TIMEOUT_MS = 15_000;
export const STALE_PENDING_MS = 60_000;
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "exec_command", "shell_command"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "apply_patch", "NotebookEdit"]);

// foreign: the turn touched another repository, so nothing is learned from it.
export interface Turn { user: KnowledgeEvent; source: Source; start: string; end: string | null; eventIds: Set<string>; agentEventIds: Set<string>; edits: string[]; commands: number; foreign: boolean }
interface Pending { session: string; turn: string; message: string; created_at: string }
export type Verdict =
  | { kind: "silence" }
  | { kind: "classified"; message: KnowledgeEvent; correction: boolean; contradicted: string[]; explanation: string | null }
  | { kind: "withheld"; reason: string };

const meta = (source: Source | undefined) => { try { return source?.content ? JSON.parse(source.content) : {}; } catch { return {}; } };
const data = (event: KnowledgeEvent) => { try { return JSON.parse(event.content); } catch { return null; } };
const inZone = (file: string, zones: string[]) => zones.some(z => file === z || file.startsWith(z.replace(/\/$/, "") + "/"));
const normalized = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.!;:,\s]+$/, "").toLowerCase();

/** Existing knowledge with the same text, or overlapping quotes from the same message. */
export function sameKnowledge(store: KnowledgeStore, text: string, eventId: string, except?: string): KnowledgeVersion | undefined {
  const wanted = normalized(text);
  return [...heads(store).values()].find(v => {
    if (v.knowledge_id === except) return false;
    const have = normalized(v.content);
    return have === wanted || (v.event_ids.includes(eventId) && wanted.length > 0 && have.length > 0 && (have.includes(wanted) || wanted.includes(have)));
  });
}

/** Turns of a session: a user message and everything until the next one. */
export function sessionTurns(store: KnowledgeStore, session: string): Turn[] {
  const sources = new Map(store.sources.map(s => [s.id, s]));
  const events = store.events.filter(e => e.session_id === session && e.id.startsWith("capture-event:")).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id));
  const turns: Turn[] = [];
  for (const event of events) {
    const source = sources.get(event.source_ids[0]), m = meta(source);
    if (m.role === "user" && m.hook === "user-prompt-submit") {
      if (turns.length) turns[turns.length - 1].end = event.recorded_at;
      turns.push({ user: event, source: source!, start: event.recorded_at, end: null, eventIds: new Set([event.id]), agentEventIds: new Set(), edits: [], commands: 0, foreign: false });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    turn.eventIds.add(event.id);
    if (m.role === "assistant" || m.role === "tool") turn.agentEventIds.add(event.id);
    if (m.hook === "post-tool-use" && m.observation && SHELL_TOOLS.has(m.observation.tool)) turn.commands++;
    const o = m.observation;
    if (o?.outside === true) turn.foreign = true;
    if (m.hook === "post-tool-use" && o && EDIT_TOOLS.has(o.tool) && !o.failed && Array.isArray(o.targets)) for (const t of o.targets) if (typeof t === "string" && !turn.edits.includes(t)) turn.edits.push(t);
  }
  return turns;
}

function heads(store: KnowledgeStore): Map<string, KnowledgeVersion> {
  const out = new Map<string, KnowledgeVersion>();
  for (const v of store.versions) if ((out.get(v.knowledge_id)?.version ?? 0) < v.version) out.set(v.knowledge_id, v);
  return out;
}
const settledId = (session: string, turn: string) => `settled:${digest(`${session}:${turn}`)}`;
export const isSettled = (store: KnowledgeStore, session: string, turn: string) => store.events.some(e => e.id === settledId(session, turn));
/** Verdict of a settled turn, or null. */
export function turnVerdict(store: KnowledgeStore, session: string, turn: string): string | null {
  const event = store.events.find(e => e.id === settledId(session, turn));
  return event ? data(event)?.verdict ?? null : null;
}

/** Knowledge produced by the agent's turn. */
export function agentKnowledgeOf(store: KnowledgeStore, turn: Turn): KnowledgeVersion[] {
  return [...heads(store).values()].filter(v => v.state === "active" && v.event_ids.some(id => turn.agentEventIds.has(id)));
}

function transition(version: KnowledgeVersion, state: KnowledgeVersion["state"], eventId: string, now: string): KnowledgeVersion {
  return { ...version, id: `version:${digest(`${version.id}:${state}:${eventId}`)}`, version: version.version + 1, previous_version_id: version.id, state, event_ids: [...new Set([...version.event_ids, eventId])], recorded_at: now };
}

/** Records the verdict on one turn exactly once. */
export function settleTurn(root: string, session: string, turnId: string, verdict: Verdict): void {
  appendKnowledge(root, store => {
    const batch = emptyBatch();
    if (isSettled(store, session, turnId)) return batch;
    const turn = sessionTurns(store, session).find(t => t.user.id === turnId);
    if (!turn) return batch;
    const now = new Date().toISOString(), current = heads(store);
    const settle = (content: Record<string, unknown>) => batch.events.push({ id: settledId(session, turnId), kind: "observation", source_ids: [turn.source.id], actor: null, session_id: session, occurred_at: null, recorded_at: now, content: JSON.stringify({ protocol: SETTLED, session, turn: turnId, ...content }) });
    if (verdict.kind === "withheld") {
      const id = `withheld:${digest(`${session}:${turnId}`)}`;
      batch.events.push({ id, kind: "observation", source_ids: [turn.source.id], actor: null, session_id: session, occurred_at: null, recorded_at: now, content: JSON.stringify({ protocol: WITHHELD, session, turn: turnId, reason: verdict.reason, window: { start: turn.start, end: turn.end } }) });
      for (const v of agentKnowledgeOf(store, turn)) batch.versions.push(transition(v, "archived", id, now));
      settle({ verdict: "withheld" });
      return batch;
    }
    const corrected = verdict.kind === "classified" && verdict.correction;
    if (!corrected) {
      // Ending a session confirms nothing.
      if (verdict.kind === "silence") { settle({ verdict: "session_end" }); return batch; }
      // A next message that is not a correction confirms the knowledge that served.
      const injected = new Set(injectedMemories(root, session).filter(i => i.at >= turn.start && (!turn.end || i.at < turn.end)).map(i => i.version_id));
      for (const versionId of injected) {
        const version = store.versions.find(v => v.id === versionId);
        const head = version && current.get(version.knowledge_id);
        if (!head || head.state !== "active") continue;
        const served = head.zones.length ? turn.edits.some(f => inZone(f, head.zones)) : turn.edits.length > 0;
        if (!served) continue;
        batch.events.push({ id: `confirm:${digest(`${head.knowledge_id}:${session}:${turnId}`)}`, kind: "observation", source_ids: [turn.source.id], actor: null, session_id: session, occurred_at: null, recorded_at: now, content: JSON.stringify({ protocol: CONFIRMATION, knowledge_id: head.knowledge_id, version_id: head.id, session, turn: turnId }) });
      }
      settle({ verdict: "no_correction" });
      return batch;
    }
    const message = verdict.message, messageSource = store.sources.find(s => s.id === message.source_ids[0]);
    if (!messageSource) return batch;
    const correctionId = `correction:${digest(`${session}:${message.id}`)}`;
    const zones = turn.edits.slice(0, 8);
    batch.events.push({ id: correctionId, kind: "observation", source_ids: [messageSource.id], actor: message.actor, session_id: session, occurred_at: null, recorded_at: now, content: JSON.stringify({ protocol: CORRECTION, session, turn: turnId, message_event_id: message.id, zones, window: { start: turn.start, end: turn.end }, contradicted: verdict.contradicted }) });
    const contested = new Set<string>();
    for (const id of verdict.contradicted) {
      const version = store.versions.find(v => v.id === id);
      const head = version && current.get(version.knowledge_id);
      if (head?.state === "active" && !contested.has(head.knowledge_id)) { contested.add(head.knowledge_id); batch.versions.push(transition(head, "contested", correctionId, now)); }
    }
    for (const v of agentKnowledgeOf(store, turn)) if (!contested.has(v.knowledge_id) && (!v.zones.length || v.zones.some(z => zones.some(f => inZone(f, [z]))))) {
      contested.add(v.knowledge_id); batch.versions.push(transition(v, "contested", correctionId, now));
    }
    // Another repository: the correction still contests, but its explanation is not kept.
    if (verdict.explanation && message.content.includes(verdict.explanation) && !turn.foreign) {
      const knowledgeId = `correction:${digest(`${message.id}:${verdict.explanation}`)}`;
      const extracted = current.has(knowledgeId) ? undefined : sameKnowledge(store, verdict.explanation, message.id);
      if (extracted?.state === "active" && !contested.has(extracted.knowledge_id)) batch.versions.push({ ...transition(extracted, "active", correctionId, now), content: verdict.explanation, zones: extracted.zones.length ? extracted.zones : zones, event_ids: [...new Set([...extracted.event_ids, message.id, correctionId])], source_ids: [...new Set([...extracted.source_ids, messageSource.id])] });
      else if (!extracted && !current.has(knowledgeId)) batch.versions.push({ id: `version:${digest(`${knowledgeId}:1`)}`, knowledge_id: knowledgeId, version: 1, previous_version_id: null, kind: "constraint", state: "active", content: verdict.explanation, zones, source_ids: [messageSource.id], event_ids: [message.id, correctionId], recorded_at: now, valid_from: null, valid_until: null, legacy_pattern_id: null, legacy_score: null });
    }
    settle({ verdict: "correction" });
    return batch;
  });
}

/** Extraction finishing after a verdict follows it. */
export function verdictFor(store: KnowledgeStore, session: string, eventId: string): { state: "contested" | "withheld"; eventId: string } | null {
  const turn = sessionTurns(store, session).find(t => t.agentEventIds.has(eventId));
  if (!turn) return null;
  for (const e of store.events) {
    if (e.session_id !== session) continue;
    const d = data(e);
    if (d?.turn !== turn.user.id) continue;
    if (d.protocol === WITHHELD) return { state: "withheld", eventId: e.id };
    if (d.protocol === CORRECTION) return { state: "contested", eventId: e.id };
  }
  return null;
}

const pendingPath = (root: string, session: string) => join(dirname(knowledgePath(root)), "context", `pending-${sessionKey(session)}.json`);
function readPending(root: string, session: string): Pending | null { try { return JSON.parse(readFileSync(pendingPath(root, session), "utf8")); } catch { return null; } }
function writePending(root: string, pending: Pending): void {
  const file = pendingPath(root, pending.session); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(pending), { mode: 0o600 }); renameSync(temporary, file);
}
function clearPending(root: string, session: string, message: string): void {
  if (readPending(root, session)?.message !== message) return;
  try { unlinkSync(pendingPath(root, session)); } catch { /* Already cleared. */ }
}

/** Versions held back while the previous turn is judged. */
export function suspendedVersions(root: string, session: string | undefined, store: KnowledgeStore): Set<string> {
  if (!session) return new Set();
  const pending = readPending(root, session);
  if (!pending) return new Set();
  const turn = sessionTurns(store, session).find(t => t.user.id === pending.turn);
  return new Set(turn ? agentKnowledgeOf(store, turn).map(v => v.id) : []);
}

export function automaticEnabled(root: string, session: string | undefined): session is string {
  if (!session || !repoActivated(root) || !memoryEnabled(root) || !sessionCaptureEnabled(root, session)) return false;
  return !!engineTarget(root, "correction");
}

/** Withholds the turn of a classifier that died. */
function resolveStale(root: string, session: string): void {
  const pending = readPending(root, session);
  if (!pending || Date.now() - Date.parse(pending.created_at) < STALE_PENDING_MS) return;
  settleTurn(root, session, pending.turn, { kind: "withheld", reason: "classifier_unavailable" });
  clearPending(root, session, pending.message);
}

/** On each user message, asks in the background whether it corrects the previous turn. Never blocks the agent. */
export function startCorrectionCheck(root: string, session: string | undefined): void {
  if (!automaticEnabled(root, session)) return;
  resolveStale(root, session);
  ingestSession(root, session);
  const store = readKnowledgeFor(root, { session, depth: 0 }), turns = sessionTurns(store, session);
  if (turns.length < 2) return;
  const message = turns[turns.length - 1].user, judged = turns[turns.length - 2];
  if (isSettled(store, session, judged.user.id)) return;
  writePending(root, { session, turn: judged.user.id, message: message.id, created_at: new Date().toISOString() });
  const child = spawn(process.execPath, [process.argv[1], "sessions", "correction", session, message.id], { cwd: root, env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", () => {}); child.unref();
}

/** Rules injected in this session, newest first. */
function injectedRules(root: string, session: string, store: KnowledgeStore): { id: string; text: string }[] {
  const current = heads(store), seen = new Set<string>(), rules: { id: string; text: string }[] = [];
  for (const { version_id } of injectedMemories(root, session).reverse()) {
    const version = store.versions.find(v => v.id === version_id);
    const head = version && current.get(version.knowledge_id);
    if (!head || head.state !== "active" || seen.has(head.id)) continue;
    seen.add(head.id); rules.push({ id: head.id, text: head.content.slice(0, 1200) });
    if (rules.length >= 12) break;
  }
  return rules;
}

/** Runs in the detached process started by startCorrectionCheck. */
export async function runCorrectionCheck(root: string, session: string, messageId: string): Promise<Verdict["kind"] | "skipped"> {
  if (!automaticEnabled(root, session)) return "skipped";
  const pending = readPending(root, session);
  if (!pending || pending.message !== messageId) return "skipped";
  let verdict: Verdict;
  try {
    ingestSession(root, session);
    const store = readKnowledge(root);
    const message = store.events.find(e => e.id === messageId);
    if (!message) throw new Error("message_not_captured");
    const rules = injectedRules(root, session, store);
    const judged = sessionTurns(store, session).find(t => t.user.id === pending.turn);
    const context = { agent_edited_files: (judged?.edits ?? []).slice(0, 20), agent_ran_commands: judged?.commands ?? 0 };
    const target = engineTarget(root, "correction");
    if (!target) throw new Error("engine_not_configured");
    const response = await policyFetch(target.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(CORRECTION_TIMEOUT_MS), headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` }, body: JSON.stringify({ protocol: 1, message: message.content, rules, context, ...target.where }) }, target.purpose);
    if (!response.ok) { await noticeMemoryRefusal(root, target, response); throw new Error(`engine_http_${response.status}`); }
    const result = await response.json() as { protocol?: number; correction?: unknown; contradicted?: unknown; explanation?: unknown };
    const ids = new Set(rules.map(r => r.id));
    if (result.protocol !== 1 || typeof result.correction !== "boolean" || !Array.isArray(result.contradicted) || !result.contradicted.every(id => typeof id === "string" && ids.has(id)) || !(result.explanation === null || (typeof result.explanation === "string" && message.content.includes(result.explanation)))) throw new Error("invalid_correction_response");
    verdict = { kind: "classified", message, correction: result.correction, contradicted: result.correction ? result.contradicted as string[] : [], explanation: result.correction ? result.explanation as string | null : null };
  } catch (error) {
    verdict = { kind: "withheld", reason: error instanceof Error ? error.message.slice(0, 80) : "classifier_error" };
  }
  try {
    settleTurn(root, session, pending.turn, verdict);
    try { purgeCaptureText(root, session); } catch { /* Store busy: erased later. */ }
  } finally { clearPending(root, session, messageId); }
  backgroundUpkeep(root);
  try { await syncShared(root); } catch { /* Offline or busy: sent later. */ }
  return verdict.kind;
}

/** Settles the last turn at session end, confirming nothing. */
export function settleSessionEnd(root: string, session: string | undefined): void {
  if (!automaticEnabled(root, session)) return;
  resolveStale(root, session);
  ingestSession(root, session);
  const store = readKnowledgeFor(root, { session, depth: 0 }), last = sessionTurns(store, session).at(-1);
  if (last && !isSettled(store, session, last.user.id)) settleTurn(root, session, last.user.id, { kind: "silence" });
  try { purgeCaptureText(root, session); } catch { /* Store busy: erased later. */ }
}

