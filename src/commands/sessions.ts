import { repoRoot } from "../repository/git.js";
import { memoryEnabled, repoActivated } from "../storage/state.js";
import { captureEnabled, ingestSession, listSessions, readSession, sessionsPath, setCaptureEnabled } from "../integrations/session-capture.js";
import { configureLearning, learnSession, learningConfig, selectResume } from "../memory/session-learning.js";
import { runCorrectionCheck } from "../memory/automatic.js";

export async function sessionsCommand(action: string, session?: string, message?: string): Promise<void> {
  const root = repoRoot();
  // Detached step of automatic memory: classify one user message and settle the previous turn.
  if (action === "correction") {
    if (!session || !message) throw new Error("Usage: kurtel sessions correction <session-id> <message-event-id>");
    console.log(JSON.stringify({ verdict: await runCorrectionCheck(root, session, message) })); return;
  }
  if (["engine", "learn", "resume", "learning-off"].includes(action)) {
    if (action !== "learning-off" && !session) throw new Error(`A target is required for sessions ${action}`);
    if (action === "engine") configureLearning(root, session);
    if (action === "learning-off") configureLearning(root);
    if (action === "learn") { console.log(JSON.stringify(await learnSession(root, session!))); return; }
    if (action === "resume") { console.log(selectResume(root, session!)); return; }
    console.log(JSON.stringify(learningConfig(root))); return;
  }
  if (action === "list") { process.stdout.write(JSON.stringify(listSessions(root), null, 2) + "\n"); return; }
  if (action === "on" || action === "off") {
    if (session && !["codex", "claude-code"].includes(session)) throw new Error("Capture provider: codex | claude-code");
    setCaptureEnabled(root, action === "on", session === "codex" ? "codex" : "claude-code");
  }
  else if (action === "show" || action === "ingest") {
    if (!session) throw new Error(`Usage: kurtel sessions ${action} <session-id>`);
    const result = action === "show" ? readSession(root, session) : { imported: ingestSession(root, session) };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  } else if (action !== "status") throw new Error("Use: kurtel sessions on | off | status | list | show <session-id> | ingest <session-id>");
  const enabled = captureEnabled(root);
  const codexEnabled = captureEnabled(root, "codex");
  process.stdout.write(JSON.stringify({ enabled, active: enabled && repoActivated(root) && memoryEnabled(root), codex_enabled: codexEnabled, codex_hook_trust: "unknown_check_client", codex_active: codexEnabled && repoActivated(root) && memoryEnabled(root), path: sessionsPath(root), capture_local_only: true, learning: learningConfig(root) }, null, 2) + "\n");
}
