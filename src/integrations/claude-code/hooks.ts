import { repoRoot, headCommit } from "../../repository/git.js";
import { loadIndex } from "../../storage/graph-index.js";
import { kurtelEnabled, memoryEnabled, repoActivated } from "../../storage/state.js";
import { appendInjectionLog } from "../../storage/journal.js";
import { compactContext } from "../../context/compact.js";
import { deliverContext, resetContext } from "../../context/delivery.js";
import { packContext } from "../../context/budget.js";
import { recordInjection, recordToolUse } from "../../storage/usage.js";
import { digest } from "../../storage/knowledge.js";
import { findSimilarRoutes } from "../../graph/indexer.js";
import { resolveTarget, computeImpact } from "../../graph/impact.js";
import { ensureWatcher } from "../../runtime/reindex.js";
import { captureHook, captureEnabled, ingestSession, type CaptureInput } from "./capture.js";
import { consumeResume, learningInBackground } from "../../memory/session-learning.js";
import { settleSessionEnd, startCorrectionCheck } from "../../memory/automatic.js";
import { purgeCaptureText } from "../../memory/capture-retention.js";
import { shareInBackground } from "../../memory/shared.js";
import { backgroundUpkeep } from "../../memory/upkeep.js";
import { accessEntry, accessGated, activeAccess, checkAccess, checkAccessInBackground, purgePending } from "../../storage/access.js";
import { originRemote } from "../../repository/remote.js";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface HookInput extends CaptureInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function readStdin(): Promise<string> {
  const dbg = (m: string) => { if (process.env.KURTEL_DEBUG) console.error(`[kurtel stdin] ${m}`); };
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    let oversized = false;
    process.stdin.on("data", (c: string) => {
      if (oversized) return;
      if (Buffer.byteLength(data) + Buffer.byteLength(c) > 2 * 1024 * 1024) { oversized = true; data = ""; return; }
      data += c;
    });
    process.stdin.on("end", () => { dbg(`end (${data.length})`); resolve(data); });
    process.stdin.on("error", (e) => { dbg(`error ${e} (${data.length})`); resolve(data); });
    setTimeout(() => { dbg(`timeout (${data.length})`); resolve(data); }, 2000).unref?.();
  });
}

function emitContext(
  root: string,
  event: string,
  context: string,
  meta?: { prompt?: string; file?: string; shared?: boolean }
): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
    })
  );
  // Local journal of what was injected (best effort).
  if (!meta?.shared) appendInjectionLog(root, formatLogEntry(event, context, meta));
}

function formatLogEntry(
  event: string,
  context: string,
  meta?: { prompt?: string; file?: string }
): string {
  const ts = new Date().toISOString().replace("T", " ").replace(/\..+$/, "");
  const lines = [``, `## ${ts} · ${event}`];
  if (meta?.prompt) lines.push(`> ${meta.prompt.replace(/\s+/g, " ").trim()}`);
  if (meta?.file) lines.push(`> file: ${meta.file}`);
  lines.push(``, context, ``, `---`);
  return lines.join("\n") + "\n";
}

export async function hookCommand(event: string): Promise<void> {
  try {
    const raw = await readStdin();
    let input: HookInput = {};
    try { input = raw ? JSON.parse(raw) : {}; } catch { /* stdin non-JSON */ }

    const root = repoRoot(input.cwd ?? process.cwd());
    // Silent outside a declared repository the developer has access to.
    if (!(await hookAccess(root, event))) return;
    if (!kurtelEnabled(root)) return;

    if (memoryEnabled(root)) try {
      captureHook(root, event, input);
      if (["stop", "session-end"].includes(event) && typeof input.session_id === "string" && input.session_id && captureEnabled(root)) {
        ingestSession(root, input.session_id);
        learningInBackground(root, input.session_id);
      }
    } catch (error) {
      if (process.env.KURTEL_DEBUG) console.error("[kurtel capture]", error);
    }

    switch (event) {
      case "session-start":  return onSessionStart(root, input);
      case "user-prompt-submit": return await onPrompt(root, input);
      case "pre-tool-use":   return await onPreToolUse(root, input);
      case "post-tool-use":  return await onPostToolUse(root, input);
      case "session-end":    return onSessionEnd(root, input);
      default: return;
    }
  } catch (e) {
    /* A broken hook is worse than no hook. */
    if (process.env.KURTEL_DEBUG) console.error("[kurtel hook]", e);
  } finally {
    process.exitCode = 0;
  }
}

/** Uses the kept access; otherwise session start asks the server (1.5 s at most). */
async function hookAccess(root: string, event: string): Promise<boolean> {
  if (!accessGated()) return repoActivated(root);
  try { purgePending(); } catch { /* Retried at the next hook. */ }
  const granted = activeAccess(root);
  if (granted) {
    // No memory yet: ask again in the background in case it was turned on.
    if (event === "session-start" && granted.memory !== true) checkAccessInBackground(root);
    return true;
  }
  if (!originRemote(root)) return false;
  if (event === "session-start") {
    const entry = await checkAccess(root, { timeoutMs: 1500 });
    if (entry?.active) return true;
    if (entry?.reason === "organization_required") {
      const names = (entry.organizations ?? []).map(o => o.slug).join(", ");
      process.stdout.write(JSON.stringify({ systemMessage: `Kurtel is off: this repository is declared in several of your organizations (${names}). Choose one with kurtel org use <slug>.` }));
    }
    return false;
  }
  if (event === "user-prompt-submit" && !accessEntry(root)) checkAccessInBackground(root);
  return false;
}

function onSessionStart(root: string, input: HookInput): void {
  resetContext(root, input.session_id);
  try { shareInBackground(root); } catch { /* Sharing never blocks the session. */ }
  ensureWatcher(root);

  const index = loadIndex(root);
  let resume = "";
  if (memoryEnabled(root)) try { resume = consumeResume(root, input.session_id); } catch { /* Context still works without it. */ }
  if (!index && !resume) return;

  const bits: string[] = [];
  if (index) bits.push(`codebase index: ${index.files_indexed} files, ${index.routes.length} routes (commit ${headCommit(root).slice(0, 8)})`);
  const context = packContext([
    { key: "summary", text: `[Kurtel active — ${bits.join(", ")}. Context is supplied per task.]`, priority: 20 },
    ...(resume ? [{ key: "resume", text: resume, priority: 80 }] : []),
  ], 2000);
  if (context.omitted.includes("resume")) context.text = packContext([{ key: "omitted", text: "Kurtel: working memory exceeds the startup budget. Run kurtel sessions resume to inspect it explicitly.", priority: 100 }], 2000).text;
  if (context.text) emitContext(root, "SessionStart", context.text);
}

async function onPrompt(root: string, input: HookInput): Promise<void> {
  const prompt = input.prompt ?? "";
  const dbg = (m: string) => { if (process.env.KURTEL_DEBUG) console.error(`[kurtel hook] ${m}`); };
  if (prompt.length < 8 || prompt.startsWith("/")) { dbg(`skip: prompt too short or slash (${JSON.stringify(prompt)})`); return; }

  const index = loadIndex(root);
  dbg(`root=${root} index=${!!index}`);
  try { startCorrectionCheck(root, input.session_id); } catch (e) { dbg(`correction check not started: ${e instanceof Error ? e.message : e}`); }
  try { shareInBackground(root); } catch (e) { dbg(`sharing not started: ${e instanceof Error ? e.message : e}`); }
  const capsule = await compactContext(root, index, prompt, { budget: PROMPT_TOKENS, session: input.session_id });
  if (!kurtelEnabled(root) || !repoActivated(root)) return;
  const delivered = deliverContext(root, input.session_id, capsule.items, capsule.revision, text => emitContext(root, "UserPromptSubmit", text, { prompt, shared: capsule.items.some(i => i.key.startsWith("team:")) }), { budget: PROMPT_TOKENS, stillValid: capsule.stillValid });
  recordInjection(root, input.session_id, "UserPromptSubmit", delivered.tokens, delivered.selected);
  dbg(`tokens=${delivered.tokens} scope=${capsule.scope} omitted=${delivered.omitted.length} warnings=${capsule.warnings.join("; ")}`);
}

const ROUTE_WRITE = /\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]|@(?:Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`]+)["'`]|@\w+\.(?:get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/;
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit"];
// Injection budgets, in estimated tokens.
const PROMPT_TOKENS = 600, PRE_EDIT_TOKENS = 600, POST_EDIT_TOKENS = 300;

/** Repository-relative path of a tool target, or null outside the repository. */
function toolFile(root: string, input: HookInput): string | null {
  const ti = input.tool_input ?? {};
  const raw = ti.file_path ?? ti.notebook_path ?? ti.path ?? "";
  if (typeof raw !== "string" || !raw) return null;
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  const file = raw.replace(/\\/g, "/");
  const relative = /^(?:[A-Za-z]:)?\//.test(file) ? (file.toLowerCase().startsWith(base.toLowerCase() + "/") ? file.slice(base.length + 1) : null) : file.replace(/^\.\//, "");
  return relative && !relative.split("/").includes("..") ? relative : null;
}

/** Repository holding a tool target, if Kurtel works there. No network or Git call: runs before an edit. */
function fileRepository(sessionRoot: string, input: HookInput): string | null {
  const ti = input.tool_input ?? {};
  const raw = ti.file_path ?? ti.notebook_path ?? ti.path ?? "";
  if (typeof raw !== "string" || !raw || !isAbsolute(raw)) return sessionRoot;
  if (toolFile(sessionRoot, input)) return sessionRoot;
  for (let dir = dirname(resolve(raw)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return !accessGated() ? null : activeAccess(dir) ? dir : null;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Rules for a file, before its first edit in the session. PreToolUse context arrives after the edit, so by default
 * the first edit is declined once with the rules as the reason. KURTEL_PRE_EDIT=context|off changes this.
 */
async function onPreToolUse(sessionRoot: string, input: HookInput): Promise<void> {
  if (!EDIT_TOOLS.includes(input.tool_name ?? "")) return;
  const policy = process.env.KURTEL_PRE_EDIT ?? "gate";
  if (policy === "off") return;
  // Rules of the file's own repository, never the session's.
  const root = fileRepository(sessionRoot, input);
  if (!root) return;
  const filePath = toolFile(root, input);
  if (!filePath) return;
  const capsule = await compactContext(root, loadIndex(root), filePath, { paths: [filePath], memoryOnly: true, budget: PRE_EDIT_TOKENS, session: input.session_id });
  if (!memoryEnabled(root) || !repoActivated(root)) return;
  if (!capsule.items.length) {
    deliverContext(root, input.session_id, [], capsule.revision, text => emitContext(root, "PreToolUse", text), { budget: PRE_EDIT_TOKENS, stillValid: capsule.stillValid });
    return;
  }
  const delivered = deliverContext(root, input.session_id, capsule.items, capsule.revision, text => {
    const body = text.replace(/^\[Kurtel context:[^\]]*\]\s*/, "");
    const rules = `Kurtel — sourced rules for ${filePath}, shown once before its first edit in this session:\n${body}`;
    const hookSpecificOutput = policy === "context"
      ? { hookEventName: "PreToolUse", additionalContext: rules }
      : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${rules}\n\nNot an error: re-issue the same edit if it already complies; otherwise adapt it first. This file will not be held again.` };
    process.stdout.write(JSON.stringify({ hookSpecificOutput }));
    if (!capsule.items.some(i => i.key.startsWith("team:"))) appendInjectionLog(root, formatLogEntry(`PreToolUse (${policy})`, rules, { file: filePath }));
  }, { budget: PRE_EDIT_TOKENS, stillValid: capsule.stillValid });
  recordInjection(root, input.session_id, "PreToolUse", delivered.tokens, delivered.selected);
}

/** After an edit: duplicate routes, impact and graph neighbours. */
async function onPostToolUse(root: string, input: HookInput): Promise<void> {
  const tool = input.tool_name ?? "";
  const filePath = toolFile(root, input);
  if (filePath && ["Read", "Grep", "Glob", ...EDIT_TOOLS].includes(tool)) recordToolUse(root, input.session_id, tool, filePath);
  if (!EDIT_TOOLS.includes(tool) || !filePath) return;

  const ti = input.tool_input ?? {};
  const index = loadIndex(root);
  const messages: string[] = [];

  const written = ((ti.new_string ?? ti.content ?? "") as string);
  const rm = written.match(ROUTE_WRITE);
  if (rm && index) {
    const newPath = rm[2] ?? rm[3] ?? rm[4] ?? "";
    const similar = newPath ? findSimilarRoutes(index, newPath).filter((r) => r.file !== filePath) : [];
    if (similar.length) {
      messages.push(
        `[Kurtel duplicate-route check] The route you just wrote ("${newPath}") looks similar to existing routes:\n` +
        similar.map((r) => `- ${r.method} ${r.path} → ${r.file}:${r.line}`).join("\n") +
        `\nVerify you are not re-implementing existing work; prefer extending the existing handler.`
      );
    }
  }

  if (index) {
    const mod = index.modules.find((m) => m.id === filePath);
    const isHot = mod && (mod.degree >= 8 || (index.god_nodes ?? []).some((g) => g.id === filePath));
    if (isHot) {
      const t = resolveTarget(index, filePath);
      if (t) {
        const r = computeImpact(index, t, 3);
        if (r.transitive > 0) {
          messages.push(
            `[Kurtel impact] ${filePath}: ${r.direct} direct dependents, ${r.transitive} transitive (≤3 hops)` +
            (r.affectedRoutes.length ? ` — routes in blast radius: ${r.affectedRoutes.slice(0, 3).map((x) => x.path).join(", ")}` : "") +
            `. Check dependents before changing signatures; run \`kurtel impact ${filePath} --json\` for the full set.`
          );
        }
      }
    }
  }

  // Keyed by text so a reindex after the edit does not repeat them.
  const neighbours = index ? (await compactContext(root, index, filePath, { paths: [filePath], graphOnly: true, budget: POST_EDIT_TOKENS })).items.map(i => ({ ...i, key: `graph:${digest(i.text)}` })) : [];

  if ((!messages.length && !neighbours.length) || !kurtelEnabled(root) || !repoActivated(root)) return;
  const delivered = deliverContext(root, input.session_id, [...messages.map(text => ({ key: `tool:${digest(text)}`, text, priority: 85 })), ...neighbours], null, text => emitContext(root, "PostToolUse", text, { file: filePath }), { budget: POST_EDIT_TOKENS });
  recordInjection(root, input.session_id, "PostToolUse", delivered.tokens, delivered.selected);
}

function onSessionEnd(root: string, input: HookInput): void {
  try { settleSessionEnd(root, input.session_id); } catch (e) { if (process.env.KURTEL_DEBUG) console.error("[kurtel settle]", e); }
  try { shareInBackground(root); } catch { /* Sharing never blocks the session. */ }
  backgroundUpkeep(root);
  if (input.session_id) try { purgeCaptureText(root, input.session_id); } catch (e) { if (process.env.KURTEL_DEBUG) console.error("[kurtel retention]", e); }
}
