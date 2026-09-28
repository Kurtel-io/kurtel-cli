import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { c, symbols } from "../../ui/colors.js";
import { loadConfig } from "../../lib/config.js";
import { repoRoot, isGitRepo } from "../../repository/git.js";
import { uninstallCommitHook } from "../git/hooks.js";
import { accessGated } from "../../storage/access.js";

// Hooks are merged as structured JSON, never by string manipulation.

const KURTEL_HOOK_MARKER = "kurtel hook"; // identifies Kurtel's hooks in settings.json

const HOOK_EVENTS: { event: string; sub: string }[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "UserPromptSubmit", sub: "user-prompt-submit" },
  { event: "PreToolUse", sub: "pre-tool-use" },
  { event: "PostToolUse", sub: "post-tool-use" },
  { event: "PostToolUseFailure", sub: "post-tool-use-failure" },
  { event: "Stop", sub: "stop" },
  { event: "SessionEnd", sub: "session-end" },
];

const SLASH_COMMANDS: Record<string, string> = {

  "onboard.md": `---
description: Index this codebase and activate Kurtel memory (architecture audit + route inventory)
allowed-tools: Bash(kurtel onboard:*), Read
---
Run \`kurtel onboard --json\` with the Bash tool, then:
1. Parse the JSON output.
2. Present the architecture snapshot to the user: domains, god nodes (with edge counts — explain these are high-coupling hotspots), and the number of inventoried routes.
3. Tell them the full report is at the path in \`report_path\` and that the Kurtel graph is now active: relevant code locations (existing routes, dependencies) will be injected automatically per task.
4. If \`uploaded\` is false, mention that the graph upload failed (offline or not signed in); the graph still works locally.
Do not re-run indexing if the command fails twice; show the error instead.
`,
  "memory.md": `---
description: Toggle or inspect Kurtel memory (on / off / status / sync / share / log / preview / vectors)
allowed-tools: Bash(kurtel memory:*)
---
The user said: "$ARGUMENTS"
- If it contains "off" or "disable" → run \`kurtel memory off\` (add \`--global\` if they say "global", "everywhere", "all repos" or "partout" — disables memory on the whole machine)
- If it contains "on" or "enable" → run \`kurtel memory on\` (add \`--global\` if they say "global"/"everywhere"/"partout" — lifts the machine-wide kill switch)
- If it contains "sync" → run \`kurtel memory sync\` (sends and receives shared knowledge)
- If it contains "share" → run \`kurtel memory share status\` (add \`on\` or \`off\` if they ask to enable or disable sharing)
- If it contains "log" → the local injection journal (what memory actually injected, prompt by prompt). If it also contains "clear"/"reset" → run \`kurtel memory log clear\`. Otherwise run \`kurtel memory log\` and present the recent entries, then mention the full history lives in the gitignored file at \`<repo>/.kurtel/injection-log.md\`.
- If it contains "preview" or "inspect" → the user wants to see what WOULD be injected for a given prompt. Take the rest of their text (everything after the keyword) as the prompt and run \`kurtel memory preview "<that prompt>"\`. If no prompt text was given, ask them what prompt to preview.
- If it contains "vector" → run \`kurtel memory vectors status\` and report whether the cross-lingual table is installed (word count, dimension)
- Otherwise → run \`kurtel memory status --json\` and present a one-line summary
Relay the result conversationally. Never paste raw JSON to the user.
`,
  "status.md": `---
description: Show Kurtel memory status for this repo
allowed-tools: Bash(kurtel memory status:*)
---
Run \`kurtel memory status --json\` and summarize in 2-3 lines: memory active or not, index freshness (suggest \`/kurtel:onboard\` if none).
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
    // replace Kurtel's previous entries (idempotent), leaving the rest untouched
    for (const m of matchers) m.hooks = m.hooks.filter((h) => !isKurtelEntry(h));
    const cleaned = matchers.filter((m) => m.hooks.length > 0);

    const entry: HookEntry = { type: "command", command: `kurtel hook ${sub}`, timeout: 10 };
    if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)) {
      cleaned.push({ matcher: ".*", hooks: [entry] });
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

export async function installClaudeCodeCommand(opts: { force?: boolean } = {}): Promise<void> {
  const root = repoRoot();

  // Outside a Git repository `repoRoot()` falls back to the cwd: from the home folder this would write
  // ~/.claude/settings.json and load Kurtel in every project.
  if (resolve(root) === resolve(homedir())) {
    console.log(`${c.red(symbols.cross)} Refusing to install in your home directory — ${c.indigo("~/.claude/settings.json")} applies to ${c.white("every")} project on this machine.`);
    console.log(`${c.dim("Run this from the root of the project where you want Kurtel, e.g.")} ${c.indigo("cd my-project && kurtel install claude-code")}${c.dim(".")}`);
    process.exitCode = 1;
    return;
  }
  if (!isGitRepo(root) && !opts.force) {
    console.log(`${c.yellow(symbols.warn)} ${c.white(root)} ${c.dim("is not a git repository — this is usually a sign you're not in a project root.")}`);
    console.log(`${c.dim("Run from your project's root, or pass")} ${c.indigo("--force")} ${c.dim("to install here anyway.")}`);
    process.exitCode = 1;
    return;
  }

  const claudeDir = join(root, ".claude");
  const cmdDir = join(claudeDir, "commands", "kurtel");
  const settingsFile = join(claudeDir, "settings.json");

  console.log("");

  const config = loadConfig();
  if (config.loggedIn && config.token) {
    console.log(`${symbols.check} Using your Kurtel session ${c.dim(`(${config.account ?? "account"})`)}`);
  } else {
    console.log(`${c.yellow(symbols.warn)} ${c.dim("Not signed in — the graph works locally; run")} ${c.indigo("kurtel login")} ${c.dim("to use the features of your plan.")}`);
  }

  if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
  // Remove obsolete commands when upgrading an existing integration.
  for (const name of ["run.md", "runs.md", "agents.md", "logs.md", "run-status.md", "stop.md"]) {
    const file = join(cmdDir, name);
    if (existsSync(file)) unlinkSync(file);
  }
  for (const [name, content] of Object.entries(SLASH_COMMANDS)) {
    writeFileSync(join(cmdDir, name), content, "utf8");
  }
  console.log(`${symbols.check} ${Object.keys(SLASH_COMMANDS).length} slash commands installed ${c.dim("— type")} ${c.indigo("/kurtel:")} ${c.dim("in Claude Code to see them (graph, memory, account, project)")}`);

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
  console.log(`${symbols.check} Hooks wired into ${c.indigo(".claude/settings.json")} ${c.dim("(session, prompt, tool and Stop events)")}`);

  uninstallCommitHook(root);

  console.log("");
  if (accessGated()) {
    console.log(`${c.dim("Next: open Claude Code here. Kurtel turns on if your organization declared this repository on kurtel.io and gave you access")} ${c.dim("(check with")} ${c.indigo("kurtel access")}${c.dim("); it builds the graph at the first session.")}`);
    console.log(`${c.dim("Keep the graph only with")} ${c.indigo("kurtel memory off")}${c.dim(", or turn Kurtel off here with")} ${c.indigo("kurtel off")}${c.dim(".")}`);
  } else {
    console.log(`${c.dim("Next: open Claude Code in this repo and run")} ${c.indigo("/kurtel:onboard")} ${c.dim("to index the codebase.")}`);
    console.log(`${c.dim("Kurtel stays silent in this repository until it is onboarded. Turn it off anytime with")} ${c.indigo("kurtel off")}${c.dim(".")}`);
  }
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
  console.log(`${c.dim("You can delete")} ${c.indigo(".claude/commands/kurtel/")} ${c.dim("to remove the slash commands.")}`);
}
