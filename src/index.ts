#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./lib/version.js";
import { loadConfig } from "./lib/config.js";
import { c, symbols } from "./ui/colors.js";
import { startSession } from "./session/repl.js";
import { runCommand } from "./commands/run.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { agentsCommand } from "./commands/agents.js";
import { runsCommand } from "./commands/runs.js";
import { logsCommand, statusCommand, stopCommand } from "./commands/runtime.js";
import { configCommand } from "./commands/config.js";
import { initCommand, doctorCommand } from "./commands/project.js";
import { onboardCommand } from "./commands/onboard.js";
import { memoryCommand } from "./commands/memory.js";
import { installClaudeCodeCommand, uninstallClaudeCodeCommand } from "./commands/installClaudeCode.js";
import { hookCommand } from "./commands/hook.js";
import { impactCommand } from "./commands/impact.js";
import { watchCommand } from "./commands/watch.js";
import { learnCommand, learnCommitCommand } from "./commands/learn.js";

const program = new Command();

program
  .name("kurtel")
  .description("Launch self-improving coding agents in the cloud.")
  .version(getVersion(), "-v, --version", "Print the CLI version")
  .helpOption("-h, --help", "Show help")
  .addHelpText(
    "afterAll",
    `\n${c.dim("Run")} ${c.indigo("kurtel")} ${c.dim(
      "with no arguments to open the interactive session."
    )}\n`
  );

// Default action: interactive session
program.action(async () => {
  const config = loadConfig();
  await startSession(String(config.engine));
});

program
  .command("run")
  .description("Launch a cloud agent on a task")
  .argument("[task...]", "What you want the agent to do")
  .option("-r, --repo <repo>", "Target repository (owner/name or URL)")
  .option("-b, --branch <branch>", "Base branch (default: current git branch)")
  .option("-e, --engine <engine>", "Engine: claude-code | codex")
  .option("-m, --model <model>", "Model to use (engine-specific, optional)")
  .action(async (taskParts: string[], opts) => {
    await runCommand((taskParts ?? []).join(" "), opts);
  });

program
  .command("runs")
  .description("List your recent runs")
  .action(() => runsCommand());

program
  .command("agents")
  .alias("ps")
  .description("List active agents")
  .action(() => agentsCommand());

program
  .command("logs")
  .description("Stream a run's logs")
  .argument("<id>", "Run id")
  .option("-f, --follow", "Keep streaming until the run finishes", false)
  .action(async (id: string, opts) => logsCommand(id, opts));

program
  .command("status")
  .description("Show a run's status")
  .argument("<id>", "Run id")
  .action((id: string) => statusCommand(id));

program
  .command("stop")
  .description("Stop an agent and tear down its sandbox")
  .argument("<id>", "Agent id")
  .action(async (id: string) => stopCommand(id));

program
  .command("login")
  .description("Sign in to Kurtel")
  .action(async () => loginCommand());

program
  .command("logout")
  .description("Sign out")
  .action(async () => logoutCommand());

program
  .command("whoami")
  .description("Show the signed-in account")
  .action(() => whoamiCommand());

program
  .command("config")
  .description("View or change local configuration")
  .argument("[action]", "list | get | set", "list")
  .argument("[key]", "Config key")
  .argument("[value]", "Value (for set)")
  .action((action, key, value) => configCommand(action, key, value));

program
  .command("init")
  .description("Initialize Kurtel in the current project")
  .action(async () => initCommand());

program
  .command("doctor")
  .description("Check your environment")
  .action(() => doctorCommand());

// ── Memory & Claude Code integration ─────────────────────────────────────────

program
  .command("install")
  .description("Install a Kurtel integration (claude-code)")
  .argument("<target>", "Integration target: claude-code")
  .option("--force", "Install even if this folder is not a git repository", false)
  .action(async (target: string, opts) => {
    if (target === "claude-code") return installClaudeCodeCommand(opts);
    console.log(`${c.red(symbols.cross)} Unknown target ${c.white(target)}. Try ${c.indigo("claude-code")}.`);
    process.exitCode = 1;
  });

program
  .command("uninstall")
  .description("Remove a Kurtel integration (claude-code)")
  .argument("<target>", "Integration target: claude-code")
  .action(async (target: string) => {
    if (target === "claude-code") return uninstallClaudeCodeCommand();
    console.log(`${c.red(symbols.cross)} Unknown target ${c.white(target)}.`);
    process.exitCode = 1;
  });

program
  .command("onboard")
  .alias("setup")
  .description("Index this codebase and activate Kurtel memory")
  .option("--json", "Machine-readable output (used by /kurtel:onboard)", false)
  .option("--local", "Skip cloud upload — index stays on disk", false)
  .action(async (opts) => onboardCommand(opts));

program
  .command("impact")
  .description("Blast radius of changing a file or function (reverse imports + call graph)")
  .argument("[target...]", "file path, file::function, or unique function name")
  .option("--json", "Machine-readable output", false)
  .option("--depth <n>", "Max BFS depth (default 4)")
  .action(async (parts: string[], opts) => impactCommand((parts ?? []).join(" "), opts));

program
  .command("memory")
  .description("Inspect or toggle Kurtel memory (status | on | off | sync | patterns | preview | log | vectors)")
  .argument("[action]", "status | on | off | sync | patterns | preview | log | vectors", "status")
  .argument("[args...]", "extra args (e.g. `preview \"<prompt>\"`, `log clear`, `vectors import <file.vec>`)")
  .option("--json", "Machine-readable output", false)
  .option("--quiet", "No spinner/log output (used by background sync)", false)
  .option("--global", "Apply on/off to every repo on this machine (kill switch)", false)
  .option("--max <n>", "Max words to import (vectors import)")
  .option("--out <dir>", "Output dir for the built table (vectors import; default ~/.kurtel/vectors)")
  .action(async (action, args, opts) => memoryCommand(action, opts, args));

program
  .command("watch")
  .description("Continuously reindex this repo as files change (auto-starts on onboard)")
  .argument("[action]", "start | stop | status", "start")
  .option("--daemon", "Run silently in the background (used by auto-start)", false)
  .action(async (action: string, opts) => watchCommand(action, opts));

program
  .command("learn")
  .description("Teach Kurtel an explicit rule for this repo (injected to the agent immediately)")
  .argument("<rule>", "The rule to remember, in quotes")
  .action(async (rule: string) => learnCommand(rule));

// Appelée par le hook git post-commit — pas par un humain. Cachée du help.
program
  .command("learn-commit", { hidden: true })
  .action(async () => learnCommitCommand());

// Appelée par Claude Code via les hooks — pas par un humain. Cachée du help.
program
  .command("hook", { hidden: true })
  .argument("<event>", "session-start | user-prompt-submit | post-tool-use | session-end")
  .action(async (event: string) => hookCommand(event));

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(
      `${c.red(symbols.cross)} ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

main();
