import type { KnowledgeStore, KnowledgeVersion } from "../domain/knowledge.js";
import type { CodebaseIndex } from "../domain/types.js";
import { digest, emptyBatch } from "../storage/knowledge.js";
import { observeTool, verificationCommand, type PriorHint } from "./tool-observation.js";
import { codeObservations, compareCode, type CodeObservation } from "../storage/code-observations.js";

export const usageProtocol = "kurtel-usage-v1";
interface UsageEvidence {
  protocol: typeof usageProtocol;
  version_id: string;
  used_files: number;
  cited_files: number;
  observed_actions: number;
  outcome: "success" | "error" | "unknown";
  repeated_error: boolean;
  trigger_matched: boolean;
  code: CodeObservation[];
}

export function usageEvidence(root: string, store: KnowledgeStore, session: string, hints: PriorHint[]) {
  const batch = emptyBatch(), sources = new Map(store.sources.map(s => [s.id, s]));
  const captures = store.events.filter(e => e.session_id === session && e.id.startsWith("capture-event:")).flatMap(event => {
    try {
      const meta = JSON.parse(sources.get(event.source_ids[0])?.content ?? "{}");
      let tool = meta.observation;
      if (!tool && meta.role === "tool") { const old = JSON.parse(event.content); tool = observeTool(root, old.tool, { file_path: old.target, command: old.command }, old.response, meta.status === "failed"); }
      return [{ event, meta, tool }];
    } catch { return []; }
  }).sort((a, b) => a.event.recorded_at.localeCompare(b.event.recorded_at));
  for (const hint of hints) {
    let row; try { row = JSON.parse(hint.source.content!); } catch { continue; }
    const end = captures.find(c => c.event.recorded_at > row.t && ["stop", "session-end", "user-prompt-submit"].includes(c.meta.hook));
    if (!end) continue; // An incomplete capture is never an ignored-memory sample.
    const window = captures.filter(c => c.event.recorded_at > row.t && c.event.recorded_at <= end.event.recorded_at);
    const actions = window.filter(c => ["post-tool-use", "post-tool-use-failure"].includes(c.meta.hook) && c.tool);
    for (const item of row.items ?? []) {
      if (typeof item.key !== "string" || !Array.isArray(item.files)) continue;
      const version = store.versions.find(v => item.key.startsWith(`memory:action:${v.id}:`));
      if (!version) continue;
      const id = `usage-event:${digest(`${version.id}:${end.event.id}`)}`;
      if (store.events.some(e => e.id === id) || batch.events.some(e => e.id === id)) continue;
      const files: string[] = [...new Set<string>(item.files.filter((f: unknown) => typeof f === "string"))];
      const relevant = actions.filter(c => !c.tool.failed && c.tool.targets?.some((file: string) => files.some(f => file === f || file.startsWith(f + "/"))));
      const edits = relevant.filter(c => ["Edit", "Write", "MultiEdit", "apply_patch"].includes(c.tool.tool));
      const lastEdit = edits.at(-1);
      const checks = lastEdit ? actions.filter(c => c.event.recorded_at > lastEdit.event.recorded_at && ["Bash", "PowerShell", "exec_command", "shell_command"].includes(c.tool.tool) && verificationCommand(c.tool.command) && Number.isSafeInteger(c.tool.exit_code)) : [];
      const failedCheck = checks.some(c => c.tool.exit_code !== 0 || c.tool.failed);
      const cleanSuccess = checks.length > 0 && !failedCheck && checks.every(c => c.tool.exit_code === 0 && !c.tool.failed);
      const data: UsageEvidence = { protocol: usageProtocol, version_id: version.id, used_files: files.filter(f => relevant.some(c => c.tool.targets.some((p: string) => p === f || p.startsWith(f + "/")))).length,
        cited_files: files.length, observed_actions: actions.length, outcome: failedCheck ? "error" : cleanSuccess ? "success" : "unknown",
        repeated_error: edits.length > 1 || failedCheck,
        trigger_matched: false, code: Array.isArray(item.code) ? item.code : [] };
      const evidence = [...new Set([hint.source.id, ...window.flatMap(c => c.event.source_ids)])];
      if (!sources.has(hint.source.id) && !batch.sources.some(s => s.id === hint.source.id)) batch.sources.push(hint.source);
      batch.events.push({ id, kind: "observation", actor: null, session_id: session, occurred_at: null, recorded_at: end.event.recorded_at, source_ids: evidence, content: JSON.stringify(data) });
    }
  }
  return batch;
}

/** Observed facts only. Decay, thresholds and retention decisions belong to the private engine. */
export function maintenanceFacts(root: string, store: KnowledgeStore, version: KnowledgeVersion, index: CodebaseIndex | null, at: string, observedCode?: CodeObservation[], inspectLiveCode = true) {
  const records = store.events.flatMap(e => {
    try {
      const data = JSON.parse(e.content) as UsageEvidence;
      if (data.protocol !== usageProtocol || data.version_id !== version.id || e.recorded_at > at) return [];
      return [{ event: e, data }];
    } catch { return []; }
  }).sort((a, b) => a.event.recorded_at.localeCompare(b.event.recorded_at));
  const baseline = records.find(r => r.data.code.length)?.data.code ?? [];
  const current = inspectLiveCode ? observedCode ?? codeObservations(root, index, baseline.map(c => c.file)) : [];
  return { protocol: 1, started_at: version.recorded_at, code: inspectLiveCode ? compareCode(root, baseline, current) : { state: "unknown", similarity: null }, observations: records.slice(-100).map(({ event, data }) => ({
    id: event.id, at: event.recorded_at, session: digest(event.session_id ?? event.id), used_files: data.used_files, cited_files: data.cited_files,
    observed_actions: data.observed_actions, outcome: data.outcome, repeated_error: data.repeated_error, trigger_matched: data.trigger_matched,
  })) };
}
