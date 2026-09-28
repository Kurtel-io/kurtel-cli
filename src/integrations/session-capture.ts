import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KnowledgeEvent, Source } from "../domain/knowledge.js";
import { appendKnowledge, digest, emptyBatch, knowledgePath, readKnowledgeFor } from "../storage/knowledge.js";
import { memoryEnabled, repoActivated } from "../storage/state.js";
import { accessGated } from "../storage/access.js";
import { currentBranch, headCommit } from "../repository/git.js";
import { observeTool } from "../memory/tool-observation.js";
import { injectedMemories, priorInjectionHints, recordCapturedContext } from "../storage/usage.js";
import { localIdentity } from "../storage/local-identity.js";
import { usageEvidence } from "../memory/maintenance.js";
import { captureIdentity } from "../memory/team.js";

export interface CaptureInput {
  session_id?: string;
  prompt_id?: string;
  tool_use_id?: string;
  prompt?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: string;
  reason?: string;
}

interface CapturedEvent { source: Source; event: KnowledgeEvent }
export const sessionsPath = (root: string) => join(dirname(knowledgePath(root)), "sessions");
export const sessionPath = (root: string, session: string) => join(sessionsPath(root), digest(session));

export function captureEnabled(root: string, provider: "claude-code" | "codex" = "claude-code"): boolean {
  const file = join(sessionsPath(root), "config.json");
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  // Claude Code sessions are captured unless turned off with kurtel sessions off (memoryEnabled still gates it).
  // Enterprise deployments keep capture opt-in.
  if (provider === "claude-code" && accessGated()) return config.enabled !== false;
  return config[provider === "codex" ? "codex_enabled" : "enabled"] === true;
}

export const sessionCaptureEnabled = (root: string, session: string) => captureEnabled(root, session.startsWith("codex:") ? "codex" : "claude-code");

export function setCaptureEnabled(root: string, enabled: boolean, provider: "claude-code" | "codex" = "claude-code"): void {
  if (enabled && !repoActivated(root)) throw new Error("Activate this repository with kurtel onboard or kurtel memory on first");
  const dir = sessionsPath(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `config.${randomUUID()}.tmp`);
  const file = join(dir, "config.json");
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(temp, JSON.stringify({ ...previous, [provider === "codex" ? "codex_enabled" : "enabled"]: enabled }) + "\n", { mode: 0o600 });
  renameSync(temp, join(dir, "config.json"));
}

function scrub(value: string): { text: string; truncated: boolean; redacted: boolean } {
  const cleaned = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[REDACTED TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(password|api[_-]?key|access[_-]?token|authorization)\b["']?\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1=[REDACTED]");
  return { text: cleaned.slice(0, 12000), truncated: cleaned.length > 12000, redacted: cleaned !== value };
}

/** Capture only hook payloads; never open transcript_path or a path supplied by a tool. */
export function captureHook(root: string, hook: string, input: CaptureInput, provider: "claude-code" | "codex" = "claude-code"): void {
  if (!repoActivated(root) || !memoryEnabled(root) || !captureEnabled(root, provider)) return;
  if (typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 256) return;
  const session = input.session_id;
  let kind: KnowledgeEvent["kind"] = "observation";
  let role = "system";
  let content: unknown;
  let status = "observed";
  if (hook === "user-prompt-submit") { kind = "instruction"; role = "user"; content = input.prompt; }
  else if (hook === "stop") { kind = "proposal"; role = "assistant"; content = input.last_assistant_message; }
  else if (["pre-tool-use", "post-tool-use", "post-tool-use-failure"].includes(hook)) {
    kind = hook === "pre-tool-use" ? "action_attempted" : "observation";
    role = "tool";
    status = hook === "pre-tool-use" ? "requested_not_confirmed_executed" : hook === "post-tool-use-failure" ? "failed" : "result_reported_not_verified";
    // Keep commands and target paths, not entire source files passed to Read/Edit/Write.
    const ti = input.tool_input ?? {};
    content = JSON.stringify({ tool: input.tool_name, target: ti.file_path ?? ti.path, command: input.tool_name === "apply_patch" ? undefined : ti.command ?? ti.cmd,
      response: hook === "post-tool-use" && ["Bash", "PowerShell", "exec_command", "shell_command"].includes(input.tool_name ?? "") ? input.tool_response : undefined,
      error: hook === "post-tool-use-failure" ? input.error : undefined });
  } else if (hook === "session-start" || hook === "session-end") content = `${hook}: ${input.reason ?? ""}`;
  else return;
  if (typeof content !== "string" || !content.trim()) return;
  const sanitized = scrub(content);
  const promptId = typeof input.prompt_id === "string" ? input.prompt_id : null;
  const toolId = typeof input.tool_use_id === "string" ? input.tool_use_id : null;
  const stable = role === "tool" ? toolId : ["user", "assistant"].includes(role) ? promptId : null;
  // Identical text without a provider ID may be two real turns: never merge by content alone.
  const key = digest(JSON.stringify([session, hook, stable ?? randomUUID(), sanitized.text]));
  const now = new Date().toISOString();
  const teamIdentity = role === "user" ? captureIdentity(root) : null;
  const sourceId = `capture:${key}`;
  const observed = role === "tool" ? observeTool(root, input.tool_name ?? "unknown", input.tool_input ?? {}, input.tool_response, hook === "post-tool-use-failure") : undefined;
  const observation = observed ? { ...observed, targets: observed.targets.map(path => scrub(path).text), ...(observed.command ? { command: scrub(observed.command).text } : {}) } : undefined;
  const source: Source = { id: sourceId, kind: "conversation", reference: `${provider}/session/${encodeURIComponent(session)}/${hook}/${key}`, revision: stable, recorded_at: now,
    content: JSON.stringify({ provider, hook, role, status, local_author: localIdentity(true), ...(teamIdentity ? { team_identity: teamIdentity } : {}), prompt_id: promptId, tool_use_id: toolId, branch: currentBranch(root), commit: headCommit(root), observation, ...sanitized }) };
  const event: KnowledgeEvent = { id: `capture-event:${key}`, kind, source_ids: [sourceId], actor: role === "user" ? teamIdentity?.actor ?? null : role, session_id: session, occurred_at: null, recorded_at: now, content: sanitized.text };
  const dir = sessionPath(root, session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${key}.json`);
  const temporary = join(dir, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify({ source, event } satisfies CapturedEvent) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    // Publish a complete file exclusively; parallel retries cannot overwrite its timestamp.
    try { linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temporary); }
  if (hook === "post-tool-use") recordCapturedContext(root, session, input.tool_name, input.tool_response);
}

function readCapturedFiles(dir: string, session: string, files: string[]): CapturedEvent[] {
  return files.map(name => {
    const item = JSON.parse(readFileSync(join(dir, name), "utf8")) as CapturedEvent;
    if (item.event?.session_id !== session || item.source?.id !== `capture:${name.slice(0, -5)}` || item.event?.source_ids?.[0] !== item.source.id) throw new Error("Invalid capture record");
    return item;
  }).sort((a, b) => a.event.recorded_at.localeCompare(b.event.recorded_at) || a.event.id.localeCompare(b.event.id));
}

export function readSession(root: string, session: string): CapturedEvent[] {
  const dir = sessionPath(root, session);
  if (!existsSync(dir)) return [];
  return readCapturedFiles(dir, session, readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)));
}

export function listSessions(root: string): { session_id: string; events: number }[] {
  const dir = sessionsPath(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).flatMap(entry => {
    const files = readdirSync(join(dir, entry.name)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (!files.length) return [];
    const first = JSON.parse(readFileSync(join(dir, entry.name, files[0]), "utf8")) as CapturedEvent;
    const session = first.event.session_id;
    if (!session || digest(session) !== entry.name) throw new Error("Invalid session journal");
    return [{ session_id: session, events: files.length }];
  });
}

/** At most 500 new observations per flush; the journal survives lock conflicts and retries. */
export function ingestSession(root: string, session: string): number {
  const dir = sessionPath(root, session);
  if (!existsSync(dir)) return 0;
  // Only this session and the knowledge injected into it are read: usage evidence
  // looks no further, and the write checks everything else against the database.
  const scope = { session, versionIds: injectedMemories(root, session).map(i => i.version_id), depth: 0 };
  const known = new Set(readKnowledgeFor(root, scope).sources.map(s => s.id));
  const files = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && !known.has(`capture:${name.slice(0, -5)}`));
  const pending = readCapturedFiles(dir, session, files).slice(0, 500);
  if (!pending.length) return 0;
  const hints = priorInjectionHints(root, session);
  appendKnowledge(root, current => {
    const batch = { ...emptyBatch(), sources: pending.filter(p => !current.sources.some(s => s.id === p.source.id)).map(p => p.source), events: pending.filter(p => !current.events.some(e => e.id === p.event.id)).map(p => p.event) };
    const usage = usageEvidence(root, { ...current, sources: [...current.sources, ...batch.sources], events: [...current.events, ...batch.events] }, session, hints);
    batch.sources.push(...usage.sources); batch.events.push(...usage.events);
    return batch;
  }, undefined, scope);
  return pending.length;
}
