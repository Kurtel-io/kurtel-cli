import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, knowledgePath } from "../storage/knowledge.js";
import { acquireLock, releaseLock } from "../storage/lock.js";
import { packContext, type ContextItem } from "./budget.js";

// A hook holds the lease for milliseconds; Claude Code kills hooks after 10 s.
const DELIVERY_LOCK_STALE_MS = 30_000;

type Revision = string | number;
interface Ledger { revision: Revision; seen: string[] }
export interface DeliveryOptions {
  budget?: number;
  /** False for a previously delivered memory key that is no longer valid (expired, contested, engine unavailable). */
  stillValid?: (key: string) => boolean;
}
function ledgerPath(root: string, session: string) { return join(dirname(knowledgePath(root)), "context", digest(session) + ".json"); }

/**
 * Hold an exclusive lease through emission. Failed emissions never consume an item.
 * Memory delivered earlier stays delivered while the memory revision holds; a memory merely
 * irrelevant to the current request is not stale. A null revision (no memory in this request) keeps the ledger's.
 */
export function deliverContext(root: string, session: string | undefined, items: ContextItem[], requested: Revision | null, emit: (text: string) => void, options: DeliveryOptions = {}) {
  const { budget, stillValid = () => true } = options;
  if (!session) { const result = packContext(items, budget); if (result.text) emit(result.text); return result; }
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
    const changed = memoryKeys.length > 0 && (revision !== ledger.revision || (requested !== null && memoryKeys.some(key => !stillValid(key))));
    if (changed || revision !== ledger.revision) ledger.seen = [];
    const pending = items.filter(i => !ledger.seen.includes(i.key));
    if (changed) pending.unshift({ key: `revision:${revision}`, priority: 10000, text: "Kurtel memory changed. Previously injected memory is stale; reassess it. Only current action entries below may be applied to their stated paths." });
    const result = packContext(pending, budget);
    if (result.text) emit(result.text);
    writeFileSync(temporary, JSON.stringify({ revision, seen: [...ledger.seen, ...result.selected.map(i => i.key)].slice(-256) }), { mode: 0o600 });
    renameSync(temporary, path);
    return result;
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed. */ }
    releaseLock(path + ".lock", fd);
  }
}

export function resetContext(root: string, session?: string) {
  if (!session) return;
  try { unlinkSync(ledgerPath(root, session)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
