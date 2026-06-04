#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./lib/version.js";
import { loadConfig } from "./lib/config.js";
import { c, symbols } from "./ui/colors.js";
import { startSession } from "./session/repl.js";
import { runCommand } from "./commands/run.js";
import { loginCommand, logoutCommand } from "./commands/auth.js";
import { agentsCommand } from "./commands/agents.js";
import { logsCommand, statusCommand, stopCommand } from "./commands/runtime.js";
import { configCommand } from "./commands/config.js";
import { initCommand, doctorCommand } from "./commands/project.js";

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
  .option("-r, --repo <repo>", "Target repository")
  .option("-b, --branch <branch>", "Base branch", "main")
  .option("-d, --detach", "Launch without attaching to logs", false)
  .action(async (taskParts: string[], opts) => {
    await runCommand((taskParts ?? []).join(" "), opts);
  });

program
  .command("agents")
  .alias("ps")
  .description("List active agents")
  .action(() => agentsCommand());

program
  .command("logs")
  .description("Stream an agent's logs")
  .argument("<id>", "Agent id (e.g. agent-7f3a)")
  .action(async (id: string) => logsCommand(id));

program
  .command("status")
  .description("Show an agent's status")
  .argument("<id>", "Agent id")
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
