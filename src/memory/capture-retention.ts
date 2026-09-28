// Captured text is kept only until extraction and judgement no longer need it. Facts (tool, files, command) stay.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEvent, KnowledgeStore } from "../domain/knowledge.js";
import { readKnowledge, redactKnowledge } from "../storage/knowledge.js";
import { sessionPath } from "../integrations/session-capture.js";
import { extractedEvents, extractionContextIds } from "./session-learning.js";
import { automaticEnabled, isSettled, sessionTurns } from "./automatic.js";

export const ERASED = "[text erased after learning]";
/** After this long without activity, a session's text is erased. */
export const STALE_CAPTURE_MS = 7 * 24 * 3600_000;

const meta = (store: KnowledgeStore, event: KnowledgeEvent) => {
  try { return JSON.parse(store.sources.find(s => s.id === event.source_ids[0])?.content ?? "{}"); } catch { return {}; }
};
export const textErased = (store: KnowledgeStore, event: KnowledgeEvent) => event.content === ERASED || meta(store, event).text_erased === true;

/** Captures whose text is no longer needed. */
export function erasableCaptures(root: string, store: KnowledgeStore, session: string, now = Date.now()): KnowledgeEvent[] {
  const captures = store.events.filter(e => e.session_id === session && e.id.startsWith("capture-event:") && !textErased(store, e));
  if (!captures.length) return [];
  const last = Math.max(...store.events.filter(e => e.session_id === session && e.id.startsWith("capture-event:")).map(e => Date.parse(e.recorded_at)));
  if (now - last > STALE_CAPTURE_MS) return captures;
  const done = extractedEvents(store, session);
  const judging = automaticEnabled(root, session);
  const turns = sessionTurns(store, session);
  // Kept until the turn before it is settled.
  const awaitingVerdict = new Set(judging ? turns.flatMap((turn, i) => i > 0 && !isSettled(store, session, turns[i - 1].user.id) ? [turn.user.id] : []) : []);
  const ended = store.events.some(e => e.session_id === session && e.id.startsWith("capture-event:") && meta(store, e).hook === "session-end");
  const complete = ended && !awaitingVerdict.size && !store.events.some(e => e.session_id === session && e.id.startsWith("capture-event:") && !done.has(e.id) && !textErased(store, e))
    && (!judging || !turns.length || isSettled(store, session, turns[turns.length - 1].user.id));
  const context = new Set(complete ? [] : extractionContextIds(store, session));
  return captures.filter(e => done.has(e.id) && !context.has(e.id) && !awaitingVerdict.has(e.id));
}

function erasedEvent(store: KnowledgeStore, event: KnowledgeEvent): string {
  if (meta(store, event).role !== "tool") return ERASED;
  try { const { tool, target, command } = JSON.parse(event.content); return JSON.stringify({ tool, target, command, erased: true }); } catch { return ERASED; }
}

/** Erases unneeded text in a session and in stale sessions; returns how many captures. */
export function purgeCaptureText(root: string, session?: string, now = Date.now()): number {
  const store = readKnowledge(root);
  const sessions = new Set(store.events.filter(e => e.id.startsWith("capture-event:") && e.session_id).map(e => e.session_id!));
  const targets = new Map<string, KnowledgeEvent[]>();
  for (const s of sessions) {
    const erasable = s === session ? erasableCaptures(root, store, s, now) : erasableCaptures(root, store, s, now).filter(() => now - lastCapture(store, s) > STALE_CAPTURE_MS);
    if (erasable.length) targets.set(s, erasable);
  }
  if (!targets.size) return 0;
  const ids = new Set([...targets.values()].flat().map(e => e.id));
  redactKnowledge(root, current => {
    const sources = new Map<string, string>(), events = new Map<string, string>();
    for (const event of current.events) {
      if (ids.has(event.id)) {
        const source = current.sources.find(s => s.id === event.source_ids[0]);
        if (!source?.content) continue;
        const { text: _text, truncated: _truncated, redacted: _redacted, ...facts } = JSON.parse(source.content);
        sources.set(source.id, JSON.stringify({ ...facts, text_erased: true }));
        events.set(event.id, erasedEvent(current, event));
      } else if (event.id.startsWith("error:")) {
        try {
          const signal = JSON.parse(event.content);
          if (!Array.isArray(signal.excerpts) || !signal.excerpts.some((x: { event_id: string; text: string }) => ids.has(x.event_id) && x.text !== ERASED)) continue;
          signal.excerpts = signal.excerpts.map((x: { event_id: string; text: string }) => ids.has(x.event_id) ? { ...x, text: ERASED } : x);
          events.set(event.id, JSON.stringify(signal));
        } catch { continue; }
      }
    }
    return { sources, events };
  });
  for (const [s, events] of targets) for (const event of events) {
    const file = join(sessionPath(root, s), `${event.id.slice("capture-event:".length)}.json`);
    if (existsSync(file)) unlinkSync(file);
  }
  return ids.size;
}

const lastCapture = (store: KnowledgeStore, session: string) => Math.max(...store.events.filter(e => e.session_id === session && e.id.startsWith("capture-event:")).map(e => Date.parse(e.recorded_at)));
