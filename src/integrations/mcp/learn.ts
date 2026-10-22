import { captureEnabled, captureHook, ingestSession } from "../session-capture.js";
import { startCorrectionCheck } from "../../memory/automatic.js";
import { engineTarget } from "../../memory/engine.js";
import { learningInBackground } from "../../memory/session-learning.js";

export interface ConversationInput {
  session_id: string;
  idempotency_key: string;
  messages: { role: "user" | "assistant"; content: string }[];
  speaker?: string;
}

/** A passage the agent chose to hand over: captured as the hooks would, then learned from in the background. */
export function learnConversation(root: string, input: ConversationInput) {
  if (!captureEnabled(root)) throw new Error("Conversation capture is off here. Turn it on with kurtel sessions on.");
  if (!engineTarget(root, "extract")) throw new Error("No learning engine: sign in to Kurtel, or set one with kurtel sessions engine <url>.");
  const session = `mcp:${input.session_id}`, at = Date.now();
  // Dated one millisecond apart to keep their order; the key makes a retry land on the same records.
  input.messages.forEach((message, i) => {
    const id = `${input.idempotency_key}:${i}`, time = new Date(at + i).toISOString();
    if (message.role === "user") captureHook(root, "user-prompt-submit", { session_id: session, prompt_id: id, prompt: message.content, speaker: input.speaker }, "claude-code", time);
    else captureHook(root, "stop", { session_id: session, prompt_id: id, last_assistant_message: message.content }, "claude-code", time);
  });
  // A correction is judged only inside the passage: its first message may not follow the last one sent before.
  if (input.messages.filter(m => m.role === "user").length >= 2) startCorrectionCheck(root, session);
  ingestSession(root, session);
  learningInBackground(root, session);
  return { session_id: session, messages: input.messages.length, extraction: "started_in_background", note: "What the user stated as a rule becomes active knowledge once extracted; get_context returns it for later tasks." };
}
