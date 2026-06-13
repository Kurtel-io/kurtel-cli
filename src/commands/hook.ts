import {
  repoRoot,
  repoFullName,
  loadIndex,
  loadMemoryCache,
  memoryEnabled,
  loadMemoryState,
  saveMemoryState,
  queueTelemetry,
} from "../memory/store.js";
import { compileCapsule, compileZoneCapsule, findSimilarRoutes } from "../memory/capsule.js";
import { resolveTarget, computeImpact } from "../memory/impact.js";
import { syncInBackground } from "../memory/sync.js";

// ─────────────────────────────────────────────────────────────────────────────
// `kurtel hook <event>` — appelé PAR Claude Code, jamais par un humain.
// Protocole: JSON sur stdin → JSON sur stdout, exit 0 TOUJOURS (un hook qui
// crashe ne doit jamais casser une session de code). Budget temps: <50ms hors
// premier chargement; tout est lu en local, zéro réseau synchrone.
// ─────────────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;                       // UserPromptSubmit
  tool_name?: string;                    // PostToolUse
  tool_input?: Record<string, unknown>;  // PostToolUse
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    // garde-fou: si rien n'arrive, on rend la main vite
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

function emitContext(event: string, context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
    })
  );
}

export async function hookCommand(event: string): Promise<void> {
  try {
    const raw = await readStdin();
    let input: HookInput = {};
    try { input = raw ? JSON.parse(raw) : {}; } catch { /* stdin non-JSON */ }

    const root = repoRoot(input.cwd ?? process.cwd());
    if (!memoryEnabled(root)) return; // off = silence total, coût zéro

    switch (event) {
      case "session-start":  return onSessionStart(root, input);
      case "user-prompt-submit": return onPrompt(root, input);
      case "post-tool-use":  return onPostToolUse(root, input);
      case "session-end":    return onSessionEnd(root, input);
      default: return;
    }
  } catch {
    /* jamais d'erreur visible: un hook cassé est pire que pas de hook */
  } finally {
    process.exitCode = 0;
  }
}

// ── SessionStart: lancer le sync en arrière-plan + une ligne d'état ─────────

function onSessionStart(root: string, input: HookInput): void {
  syncInBackground(root); // pull patterns + flush télémétrie, détaché

  const index = loadIndex(root);
  const cache = loadMemoryCache(root);
  if (!index && !cache.patterns.length) return; // rien à dire → rien dit

  const bits: string[] = [];
  if (index) bits.push(`codebase index: ${index.files_indexed} files, ${index.routes.length} routes (commit ${index.commit.slice(0, 8)})`);
  if (cache.patterns.length) bits.push(`${cache.patterns.length} team patterns loaded`);
  emitContext(
    "SessionStart",
    `[Kurtel memory active — ${bits.join(", ")}. Relevant context will be injected per task.]`
  );
}

// ── UserPromptSubmit: LA capsule — intention → zones → patterns ─────────────

function onPrompt(root: string, input: HookInput): void {
  const prompt = input.prompt ?? "";
  if (prompt.length < 8 || prompt.startsWith("/")) return; // slash commands & micro-prompts: silence

  const index = loadIndex(root);
  const cache = loadMemoryCache(root);
  const capsule = compileCapsule(index, cache.patterns, prompt, root);
  if (!capsule) return;

  emitContext("UserPromptSubmit", capsule.text);

  // mémorise les zones couvertes (pour ne pas répéter au PostToolUse)
  const sid = input.session_id ?? "unknown";
  const state = loadMemoryState(root);
  state.session_zones[sid] = [...new Set([...(state.session_zones[sid] ?? []), ...capsule.zones])];
  saveMemoryState(root, state);

  if (capsule.injectedPatternIds.length) {
    queueTelemetry(root, {
      ts: new Date().toISOString(),
      session_id: sid,
      repo: repoFullName(root),
      kind: "patterns_injected",
      pattern_ids: capsule.injectedPatternIds,
    });
  }
}

// ── PostToolUse: dérive d'intention + anti-duplication de routes ────────────

const ROUTE_WRITE = /\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]|@(?:Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`]+)["'`]|@\w+\.(?:get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/;

function onPostToolUse(root: string, input: HookInput): void {
  if (!["Edit", "Write", "MultiEdit"].includes(input.tool_name ?? "")) return;

  const ti = input.tool_input ?? {};
  const filePathRaw = (ti.file_path ?? ti.path ?? "") as string;
  if (!filePathRaw) return;
  const filePath = filePathRaw.replace(/\\/g, "/").replace(root.replace(/\\/g, "/") + "/", "");

  const index = loadIndex(root);
  const cache = loadMemoryCache(root);
  const sid = input.session_id ?? "unknown";
  const state = loadMemoryState(root);
  const seen = new Set(state.session_zones[sid] ?? []);

  const messages: string[] = [];

  // 1. Anti-duplication: l'agent vient-il d'écrire une route qui existe déjà ?
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
      queueTelemetry(root, {
        ts: new Date().toISOString(), session_id: sid, repo: repoFullName(root),
        kind: "duplicate_flagged", detail: newPath,
      });
    }
  }

  // 2. Dérive d'intention: nouvelle zone du graphe → micro-capsule de zone.
  const zone = filePath.includes("/") ? filePath.split("/").slice(0, 2).join("/") : filePath;
  if (!seen.has(zone)) {
    const zc = compileZoneCapsule(index, cache.patterns, filePath);
    if (zc) {
      messages.push(zc.text);
      queueTelemetry(root, {
        ts: new Date().toISOString(), session_id: sid, repo: repoFullName(root),
        kind: "zone_entered", detail: zone, pattern_ids: zc.injectedPatternIds,
      });
    }
    state.session_zones[sid] = [...seen, zone];
    saveMemoryState(root, state);
  }

  // 3. Fichier à fort couplage: une ligne d'impact, la même vue que le dev.
  if (index) {
    const mod = index.modules.find((m) => m.id === filePath);
    const isHot = mod && (mod.degree >= 8 || index.god_nodes.some((g) => g.id === filePath));
    if (isHot && !seen.has("impact:" + filePath)) {
      const t = resolveTarget(index, filePath);
      if (t) {
        const r = computeImpact(index, t, 3);
        if (r.transitive > 0) {
          messages.push(
            `[Kurtel impact] ${filePath}: ${r.direct} direct dependents, ${r.transitive} transitive (≤3 hops)` +
            (r.affectedRoutes.length ? ` — routes in blast radius: ${r.affectedRoutes.slice(0, 3).map((x) => x.path).join(", ")}` : "") +
            `. Check dependents before changing signatures; run \`kurtel impact ${filePath} --json\` for the full set.`
          );
          state.session_zones[sid] = [...(state.session_zones[sid] ?? []), "impact:" + filePath];
          saveMemoryState(root, state);
        }
      }
    }
  }

  if (messages.length) emitContext("PostToolUse", messages.join("\n\n"));
}

// ── SessionEnd / Stop: flush télémétrie en arrière-plan ─────────────────────

function onSessionEnd(root: string, _input: HookInput): void {
  syncInBackground(root);
}
