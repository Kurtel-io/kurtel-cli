import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { loadConfig } from "../lib/config.js";
import { repoRoot } from "../memory/store.js";

// ─────────────────────────────────────────────────────────────────────────────
// `kurtel install claude-code`
//   1. Slash commands → .claude/commands/kurtel/*.md  (/kurtel:onboard, etc.)
//   2. Hooks → .claude/settings.json (merge JSON structuré, idempotent —
//      la leçon Graphify: jamais de manipulation de chaîne sur les settings)
//   3. Vérifie le login; réutilise le token du CLI (zéro re-auth)
// `kurtel uninstall claude-code` retire proprement nos entrées, rien d'autre.
// ─────────────────────────────────────────────────────────────────────────────

const KURTEL_HOOK_MARKER = "kurtel hook"; // identifie NOS hooks dans settings.json

const HOOK_EVENTS: { event: string; sub: string }[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "UserPromptSubmit", sub: "user-prompt-submit" },
  { event: "PostToolUse", sub: "post-tool-use" },
  { event: "SessionEnd", sub: "session-end" },
];

// ── Slash commands (markdown, format Claude Code custom commands) ───────────

const SLASH_COMMANDS: Record<string, string> = {
  "onboard.md": `---
description: Index this codebase and activate Kurtel memory (architecture audit + route inventory)
allowed-tools: Bash(kurtel onboard:*), Read
---
Run \`kurtel onboard --json\` with the Bash tool, then:
1. Parse the JSON output.
2. Present the architecture snapshot to the user: domains, god nodes (with edge counts — explain these are high-coupling hotspots), and the number of inventoried routes.
3. Tell them the full report is at the path in \`report_path\` and that Kurtel memory is now active: relevant context (existing routes, team conventions) will be injected automatically per task.
4. If \`uploaded\` is false, mention that cloud sync failed and they can retry with \`kurtel memory sync\` (memory still works locally).
Do not re-run indexing if the command fails twice; show the error instead.
`,
  "memory.md": `---
description: Toggle or inspect Kurtel memory (on / off / status / sync / patterns)
allowed-tools: Bash(kurtel memory:*)
---
The user said: "$ARGUMENTS"
- If it contains "off" or "disable" → run \`kurtel memory off\`
- If it contains "on" or "enable" → run \`kurtel memory on\`
- If it contains "sync" → run \`kurtel memory sync\`
- If it contains "pattern" → run \`kurtel memory patterns --json\` and present the patterns as a readable list (rule, confidence, zones, evidence count), sorted by confidence
- Otherwise → run \`kurtel memory status --json\` and present a one-line summary
Relay the result conversationally. Never paste raw JSON to the user.
`,
  "impact.md": `---
description: Blast radius of changing a file or function (who breaks if I touch X)
allowed-tools: Bash(kurtel impact:*)
---
The user wants the impact of changing: "$ARGUMENTS"
Run \`kurtel impact $ARGUMENTS --json\` with the Bash tool, then present:
1. Direct vs transitive dependent counts.
2. The dependency layers (depth 1 first) as a short readable list.
3. The reverse call chain if present (which functions call the target).
4. Routes in the blast radius — these are user-facing surfaces, flag them clearly.
If the command says the target was not found, suggest the file::function syntax.
`,
  "status.md": `---
description: Show Kurtel memory status for this repo
allowed-tools: Bash(kurtel memory status:*)
---
Run \`kurtel memory status --json\` and summarize in 2-3 lines: memory active or not, index freshness (suggest \`/kurtel:onboard\` if none), number of team patterns loaded and last sync time.
`,
};

// ── Merge des hooks dans settings.json ──────────────────────────────────────

type HookEntry = { type: "command"; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, Matcher[]>; [k: string]: unknown };

function isKurtelEntry(h: HookEntry): boolean {
  return typeof h.command === "string" && h.command.includes(KURTEL_HOOK_MARKER);
}

function mergeHooks(settings: Settings): Settings {
  const hooks = settings.hooks ?? {};
  for (const { event, sub } of HOOK_EVENTS) {
    const matchers: Matcher[] = hooks[event] ?? [];
    // retirer toute ancienne entrée kurtel (idempotence), sans toucher au reste
    for (const m of matchers) m.hooks = m.hooks.filter((h) => !isKurtelEntry(h));
    const cleaned = matchers.filter((m) => m.hooks.length > 0);

    const entry: HookEntry = { type: "command", command: `kurtel hook ${sub}`, timeout: 10 };
    if (event === "PostToolUse") {
      cleaned.push({ matcher: "Edit|Write|MultiEdit", hooks: [entry] });
    } else {
      cleaned.push({ hooks: [entry] });
    }
    hooks[event] = cleaned;
  }
  settings.hooks = hooks;
  return settings;
}

function removeHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  for (const event of Object.keys(settings.hooks)) {
    const matchers = settings.hooks[event]
      .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isKurtelEntry(h)) }))
      .filter((m) => m.hooks.length > 0);
    if (matchers.length) settings.hooks[event] = matchers;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function readSettings(file: string): Settings {
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Settings;
  } catch (e) {
    throw new Error(`.claude/settings.json exists but is not valid JSON — fix it first (${e instanceof Error ? e.message : e}).`);
  }
}

// ── Commandes ───────────────────────────────────────────────────────────────

export async function installClaudeCodeCommand(): Promise<void> {
  const root = repoRoot();
  const claudeDir = join(root, ".claude");
  const cmdDir = join(claudeDir, "commands", "kurtel");
  const settingsFile = join(claudeDir, "settings.json");

  console.log("");

  // 1. Login check (réutilise le token CLI — pas de re-auth).
  const config = loadConfig();
  if (config.loggedIn && config.token) {
    console.log(`${symbols.check} Using your Kurtel session ${c.dim(`(${config.account ?? "account"})`)}`);
  } else {
    console.log(`${c.yellow(symbols.warn)} ${c.dim("Not signed in — memory will work locally; run")} ${c.indigo("kurtel login")} ${c.dim("to sync patterns.")}`);
  }

  // 2. Slash commands.
  if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
  for (const [name, content] of Object.entries(SLASH_COMMANDS)) {
    writeFileSync(join(cmdDir, name), content, "utf8");
  }
  console.log(`${symbols.check} Slash commands installed: ${c.indigo("/kurtel:onboard")}, ${c.indigo("/kurtel:memory")}, ${c.indigo("/kurtel:status")}`);

  // 3. Hooks (merge structuré, idempotent).
  let settings: Settings;
  try {
    settings = readSettings(settingsFile);
  } catch (e) {
    console.log(`${c.red(symbols.cross)} ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  settings = mergeHooks(settings);
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log(`${symbols.check} Hooks wired into ${c.indigo(".claude/settings.json")} ${c.dim("(SessionStart, UserPromptSubmit, PostToolUse, SessionEnd)")}`);

  console.log("");
  console.log(`${c.dim("Next: open Claude Code in this repo and run")} ${c.indigo("/kurtel:onboard")} ${c.dim("to index the codebase.")}`);
  console.log(`${c.dim("Memory is")} ${c.indigo("on")} ${c.dim("by default — toggle with")} ${c.indigo("/kurtel:memory off")}${c.dim(".")}`);
  console.log("");
}

export async function uninstallClaudeCodeCommand(): Promise<void> {
  const root = repoRoot();
  const settingsFile = join(root, ".claude", "settings.json");

  if (existsSync(settingsFile)) {
    try {
      const settings = removeHooks(readSettings(settingsFile));
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
      console.log(`${symbols.check} Kurtel hooks removed from .claude/settings.json ${c.dim("(other hooks untouched)")}`);
    } catch (e) {
      console.log(`${c.red(symbols.cross)} ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`${c.dim("You can delete")} ${c.indigo(".claude/commands/kurtel/")} ${c.dim("to remove the slash commands.")}`);
}
