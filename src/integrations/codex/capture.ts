import { realpathSync } from "node:fs";
import { repoRoot } from "../../repository/git.js";
import { captureEnabled, captureHook, ingestSession, type CaptureInput } from "../session-capture.js";
import { memoryEnabled, repoActivated } from "../../storage/state.js";
import { learningInBackground } from "../../memory/session-learning.js";

export interface CodexInput extends CaptureInput { cwd?: string; turn_id?: string; hook_event_name?: string; source?: string }
const events: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", PreToolUse: "pre-tool-use", PostToolUse: "post-tool-use", Stop: "stop", SessionEnd: "session-end", Interrupt: "session-end" };

export function captureCodex(root: string, input: CodexInput) {
  if (!repoActivated(root) || !memoryEnabled(root) || !captureEnabled(root, "codex")) return;
  if (!input.cwd || realpathSync.native(repoRoot(input.cwd)) !== realpathSync.native(root)) return;
  if (!input.session_id || typeof input.session_id !== "string" || input.session_id.length > 240) return;
  const hook = events[input.hook_event_name ?? ""]; if (!hook) return;
  const session = `codex:${input.session_id}`;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  // The shared capture keeps patch target paths only, never source hunks.
  captureHook(root, hook, { ...input, session_id: session, prompt_id: input.turn_id, tool_input: toolInput, reason: input.hook_event_name === "Interrupt" ? "interrupted" : input.reason ?? input.source }, "codex");
  if (["Stop", "SessionEnd", "Interrupt"].includes(input.hook_event_name ?? "")) {
    ingestSession(root, session);
    learningInBackground(root, session);
  }
}

export async function codexCaptureCommand(root: string) {
  try {
    let text = "", oversized = false;
    const raw = await new Promise<string>(resolve => {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (part: string) => { if (oversized) return; if (Buffer.byteLength(text) + Buffer.byteLength(part) > 2 * 1024 * 1024) { oversized = true; text = ""; } else text += part; });
      process.stdin.on("end", () => resolve(oversized ? "" : text));
      process.stdin.on("error", () => resolve(""));
      setTimeout(() => resolve(""), 2000).unref();
    });
    if (raw) captureCodex(root, JSON.parse(raw));
  } catch (error) { if (process.env.KURTEL_DEBUG) console.error("[kurtel codex capture]", error); }
  process.stdout.write("{}");
}
