import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { loadConfig } from "../lib/config.js";
import { repoRoot } from "../memory/store.js";
import { installCommitHook, uninstallCommitHook } from "../memory/githook.js";

// ── install/uninstall claude-code: slash commands + hooks dans .claude/ ──
// Hooks mergés en JSON structuré, jamais par manipulation de chaîne.

const KURTEL_HOOK_MARKER = "kurtel hook"; // identifie nos hooks dans settings.json

const HOOK_EVENTS: { event: string; sub: string }[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "UserPromptSubmit", sub: "user-prompt-submit" },
  { event: "PostToolUse", sub: "post-tool-use" },
  { event: "SessionEnd", sub: "session-end" },
];

// ── Slash commands (markdown, format Claude Code) ───────────

const SLASH_COMMANDS: Record<string, string> = {
  // ── Codebase memory (local) ────────────────────────────────────────────────
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
description: Toggle or inspect Kurtel memory (on / off / status / sync / patterns / vectors)
allowed-tools: Bash(kurtel memory:*)
---
The user said: "$ARGUMENTS"
- If it contains "off" or "disable" → run \`kurtel memory off\`
- If it contains "on" or "enable" → run \`kurtel memory on\`
- If it contains "sync" → run \`kurtel memory sync\`
- If it contains "pattern" → run \`kurtel memory patterns --json\` and present the patterns as a readable list (rule, confidence, zones, evidence count), sorted by confidence
- If it contains "vector" → run \`kurtel memory vectors status\` and report whether the cross-lingual table is installed (word count, dimension)
- Otherwise → run \`kurtel memory status --json\` and present a one-line summary
Relay the result conversationally. Never paste raw JSON to the user.
`,
  "status.md": `---
description: Show Kurtel memory status for this repo
allowed-tools: Bash(kurtel memory status:*)
---
Run \`kurtel memory status --json\` and summarize in 2-3 lines: memory active or not, index freshness (suggest \`/kurtel:onboard\` if none), number of team patterns loaded and last sync time.
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

  // ── Cloud runs (account required) ──────────────────────────────────────────
  "run.md": `---
description: Launch a self-improving coding agent in the cloud on a task
allowed-tools: Bash(kurtel run:*)
---
The user wants to launch a cloud agent for: "$ARGUMENTS"
Run \`kurtel run $ARGUMENTS\` with the Bash tool (pass through any flags the user included: --repo, --branch, --engine, --model). Then report the run id and how to follow it: \`/kurtel:logs <id>\` or \`/kurtel:runs\`. If the command reports the user is not signed in, tell them to run \`kurtel login\` first.
`,
  "runs.md": `---
description: List your recent cloud runs
allowed-tools: Bash(kurtel runs:*)
---
Run \`kurtel runs\` with the Bash tool and present the recent runs as a short readable list (id, repo, status, age). If not signed in, say so and suggest \`kurtel login\`.
`,
  "agents.md": `---
description: List active cloud agents
allowed-tools: Bash(kurtel agents:*)
---
Run \`kurtel agents\` with the Bash tool and present the active agents concisely (id, repo, status, progress).
`,
  "logs.md": `---
description: Stream a cloud run's logs
allowed-tools: Bash(kurtel logs:*), Bash(kurtel runs:*)
---
The user wants logs for run: "$ARGUMENTS"
If an id was given, run \`kurtel logs $ARGUMENTS\` (add --follow only if the user asked to follow), then summarize the latest activity and surface any errors clearly. If no id was given, run \`kurtel runs\` first, list the runs, and ask which one.
`,
  "run-status.md": `---
description: Show a specific cloud run's status
allowed-tools: Bash(kurtel status:*), Bash(kurtel runs:*)
---
The user wants the status of run: "$ARGUMENTS"
If an id was given, run \`kurtel status $ARGUMENTS\` and report it in one line. If no id was given, run \`kurtel runs\` and ask which run.
`,
  "stop.md": `---
description: Stop a cloud agent and tear down its sandbox
allowed-tools: Bash(kurtel stop:*), Bash(kurtel agents:*)
---
The user wants to stop agent: "$ARGUMENTS"
If an id was given, run \`kurtel stop $ARGUMENTS\` and report the result. If no id was given, run \`kurtel agents\` to list active agents and ask which to stop.
`,

  // ── Account & project ──────────────────────────────────────────────────────
  "whoami.md": `---
description: Show the signed-in Kurtel account
allowed-tools: Bash(kurtel whoami:*)
---
Run \`kurtel whoami\` and report who is signed in (or that no one is, suggesting \`kurtel login\`).
`,
  "login.md": `---
description: Sign in to Kurtel
allowed-tools: Bash(kurtel whoami:*)
---
First run \`kurtel whoami\` to check the current session.
If already signed in, tell the user. If not, do NOT run \`kurtel login\` yourself — it opens a browser and is interactive. Tell the user to run \`kurtel login\` in their own terminal to sign in, then come back.
`,
  "logout.md": `---
description: Sign out of Kurtel
allowed-tools: Bash(kurtel logout:*)
---
Run \`kurtel logout\` and confirm the session was cleared.
`,
  "config.md": `---
description: View or change Kurtel local configuration
allowed-tools: Bash(kurtel config:*)
---
The user said: "$ARGUMENTS"
- If it looks like "set <key> <value>" → run \`kurtel config set <key> <value>\`
- If it looks like "get <key>" → run \`kurtel config get <key>\`
- Otherwise → run \`kurtel config list\` and present the configuration.
`,
  "init.md": `---
description: Initialize Kurtel in the current project
allowed-tools: Bash(kurtel init:*)
---
Run \`kurtel init\` and confirm the project was initialized (a project-level .kurtel/config.json is written).
`,
  "doctor.md": `---
description: Check the Kurtel environment
allowed-tools: Bash(kurtel doctor:*)
---
Run \`kurtel doctor\` and present the environment check results, flagging anything that needs attention.
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
    // purge des anciennes entrées kurtel (idempotence), sans toucher au reste
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

  const config = loadConfig();
  if (config.loggedIn && config.token) {
    console.log(`${symbols.check} Using your Kurtel session ${c.dim(`(${config.account ?? "account"})`)}`);
  } else {
    console.log(`${c.yellow(symbols.warn)} ${c.dim("Not signed in — memory will work locally; run")} ${c.indigo("kurtel login")} ${c.dim("to sync patterns.")}`);
  }

  if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
  for (const [name, content] of Object.entries(SLASH_COMMANDS)) {
    writeFileSync(join(cmdDir, name), content, "utf8");
  }
  console.log(`${symbols.check} ${Object.keys(SLASH_COMMANDS).length} slash commands installed ${c.dim("— type")} ${c.indigo("/kurtel:")} ${c.dim("in Claude Code to see them (memory, runs, account, project)")}`);

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

  // Apprentissage à chaque commit, indépendant de Claude Code (tout outil, sans agent).
  if (installCommitHook(root)) {
    console.log(`${symbols.check} Git ${c.indigo("post-commit")} hook installed ${c.dim("— every commit teaches Kurtel (works with any tool).")}`);
  }

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

  uninstallCommitHook(root);
  console.log(`${symbols.check} Git post-commit auto-learn hook removed ${c.dim("(third-party hooks untouched)")}`);
  console.log(`${c.dim("You can delete")} ${c.indigo(".claude/commands/kurtel/")} ${c.dim("to remove the slash commands.")}`);
}
