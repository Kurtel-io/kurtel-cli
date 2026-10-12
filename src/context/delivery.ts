import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, knowledgePath } from "../storage/knowledge.js";
import { memoryRef } from "../domain/knowledge.js";
import { acquireLock, releaseLock } from "../storage/lock.js";
import { packContext, type ContextItem } from "./budget.js";

// A hook holds the lease for milliseconds; Claude Code kills hooks after 10 s.
const DELIVERY_LOCK_STALE_MS = 30_000;

type Revision = string | number;
interface Ledger { revision: Revision; seen: string[] }
export interface DeliveryOptions {
  budget?: number;
  /** Longest text the host accepts in one delivery; what does not fit stays undelivered for the next one. */
  characters?: number;
  /** False for a previously delivered memory key that is no longer valid (expired, contested, engine unavailable). */
  stillValid?: (key: string) => boolean;
}
function ledgerPath(root: string, session: string) { return join(dirname(knowledgePath(root)), "context", digest(session) + ".json"); }

/**
 * Hold an exclusive lease through emission. Failed emissions never consume an item.
 * Memory delivered earlier stays delivered while it is valid: new knowledge in the store, or a memory merely
 * irrelevant to the current request, withdraws nothing. A null revision (no memory in this request) keeps the ledger's.
 */
export function deliverContext(root: string, session: string | undefined, items: ContextItem[], requested: Revision | null, emit: (text: string) => void, options: DeliveryOptions = {}) {
  const { budget, characters, stillValid = () => true } = options;
  if (!session) { const result = packContext(items, budget, characters); if (result.text) emit(result.text); return result; }
  const path = ledgerPath(root, session);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = acquireLock(path + ".lock", DELIVERY_LOCK_STALE_MS);
  if (fd === null) return packContext([], budget);
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    let ledger: Ledger = { revision: requested ?? 0, seen: [] };
    try { const value = JSON.parse(readFileSync(path, "utf8")); if ((typeof value.revision === "string" || Number.isInteger(value.revision)) && Array.isArray(value.seen) && value.seen.every((s: unknown) => typeof s === "string")) ledger = value; } catch { /* A missing ledger means a fresh context. */ }
    const revision = requested ?? ledger.revision;
    const memoryKeys = ledger.seen.filter(s => s.startsWith("memory:") || s.startsWith("legacy:") || s.startsWith("team:"));
    const withdrawn = requested !== null ? memoryKeys.filter(key => !stillValid(key)) : [];
    if (withdrawn.length) ledger.seen = ledger.seen.filter(key => !withdrawn.includes(key));
    const pending = items.filter(i => !ledger.seen.includes(i.key));
    // The agent is told which lines to drop, not that everything it was given is in doubt.
    const named = withdrawn.map(key => { const id = /^memory:action:(.+):[^:]+$/.exec(key)?.[1]; return id ? `Memory ${memoryRef(id)}` : "a shared team line"; });
    if (withdrawn.length) pending.unshift({ key: `withdrawn:${digest(withdrawn.join("|"))}`, priority: 10000, text: `Kurtel: these remembered lines are no longer confirmed as current (corrected, replaced, expired, or memory unavailable): ${[...new Set(named)].join(", ")}. Do not rely on them.` });
    const result = packContext(pending, budget, characters);
    if (result.text) emit(result.text);
    writeFileSync(temporary, JSON.stringify({ revision, seen: [...ledger.seen, ...result.selected.map(i => i.key)].slice(-256) }), { mode: 0o600 });
    renameSync(temporary, path);
    return result;
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed. */ }
    releaseLock(path + ".lock", fd);
  }
}

/** Versions of memory already delivered in a session. */
export function deliveredMemory(root: string, session: string | undefined): Set<string> {
  const versions = new Set<string>();
  if (!session) return versions;
  try {
    const ledger = JSON.parse(readFileSync(ledgerPath(root, session), "utf8")) as Ledger;
    if (!Array.isArray(ledger.seen)) return versions;
    for (const key of ledger.seen) { const id = /^memory:action:(.+):[^:]+$/.exec(key)?.[1]; if (id) versions.add(id); }
  } catch { /* No ledger yet: nothing delivered. */ }
  return versions;
}

export function resetContext(root: string, session?: string) {
  if (!session) return;
  try { unlinkSync(ledgerPath(root, session)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
