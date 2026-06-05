import * as readline from "node:readline";
import { c, symbols } from "../ui/colors.js";
import { banner, welcomeBox } from "../ui/banner.js";
import { loadConfig } from "../lib/config.js";
import { agentsCommand } from "../commands/agents.js";
import { loginCommand } from "../commands/auth.js";
import { configCommand } from "../commands/config.js";
import { runCommand } from "../commands/run.js";

const SLASH_COMMANDS: Array<[string, string]> = [
  ["/help", "Show this help"],
  ["/run <task>", "Launch a cloud agent on a task"],
  ["/agents", "List active agents"],
  ["/login", "Sign in to Kurtel"],
  ["/config", "Show local configuration"],
  ["/clear", "Clear the screen"],
  ["/exit", "Quit the session"],
];

function prompt(): string {
  return `${c.indigo("kurtel")} ${c.indigo(symbols.arrow)} `;
}

function printHelp(): void {
  console.log("");
  console.log(c.indigoBold("Commands"));
  for (const [cmd, desc] of SLASH_COMMANDS) {
    console.log(`  ${c.indigo(cmd.padEnd(16))} ${c.dim(desc)}`);
  }
  console.log("");
  console.log(
    c.dim("Anything else you type is treated as a task and launches an agent.")
  );
  console.log("");
}

// While we're collecting answers via rl.question, the main "line" handler must
// stand down so it doesn't re-interpret the answers as new commands.
let asking = false;

function ask(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => resolve(answer.trim()));
  });
}

// Interactive launch: ask for repo / branch / engine / model (with sensible
// defaults from local config), then hand off to the real run command.
async function launchFromPrompt(
  rl: readline.Interface,
  task: string
): Promise<void> {
  const cfg = loadConfig();
  const defBranch = cfg.defaultBranch || "main";
  const defEngine = cfg.engine || "claude-code";

  let repo = "";
  let branch = defBranch;
  let engine = defEngine;
  let model = "";

  asking = true;
  try {
    console.log("");
    repo = await ask(
      rl,
      `  ${c.gray("repo")}    ${c.dim("(owner/name, empty for none)")} ${c.indigo(symbols.arrow)} `
    );
    branch =
      (await ask(
        rl,
        `  ${c.gray("branch")}  ${c.dim(`(default ${defBranch})`)} ${c.indigo(symbols.arrow)} `
      )) || defBranch;
    engine =
      (await ask(
        rl,
        `  ${c.gray("engine")}  ${c.dim(`(default ${defEngine})`)} ${c.indigo(symbols.arrow)} `
      )) || defEngine;
    model = await ask(
      rl,
      `  ${c.gray("model")}   ${c.dim("(optional)")} ${c.indigo(symbols.arrow)} `
    );
  } finally {
    asking = false;
  }

  await runCommand(task, {
    repo: repo || undefined,
    branch,
    engine,
    model: model || undefined,
  });
}

export async function startSession(model: string): Promise<void> {
  console.log(banner());
  console.log(welcomeBox(process.cwd(), model));
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: prompt(),
    completer: (line: string) => {
      const hits = SLASH_COMMANDS.map(([cmd]) => cmd.split(" ")[0]).filter((cmd) =>
        cmd.startsWith(line)
      );
      return [hits.length ? hits : [], line];
    },
  });

  rl.prompt();

  rl.on("line", async (input) => {
    // Standing down while collecting answers to /run questions.
    if (asking) return;

    const line = input.trim();

    if (line === "") {
      rl.prompt();
      return;
    }

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(" ");
      const arg = rest.join(" ").trim();

      switch (cmd) {
        case "help":
        case "?":
          printHelp();
          break;
        case "exit":
        case "quit":
        case "q":
          rl.close();
          return;
        case "clear":
          console.clear();
          console.log(banner());
          break;
        case "agents":
        case "ps":
          rl.pause();
          agentsCommand();
          rl.resume();
          break;
        case "login":
          rl.pause();
          await loginCommand();
          rl.resume();
          break;
        case "config":
          rl.pause();
          configCommand("list");
          rl.resume();
          break;
        case "run":
          if (!arg) {
            console.log(
              `${c.red(symbols.cross)} Usage: ${c.indigo("/run <task>")}`
            );
          } else {
            await launchFromPrompt(rl, arg);
          }
          break;
        default:
          console.log(
            `${c.red(symbols.cross)} Unknown command ${c.white(
              "/" + cmd
            )}. Type ${c.indigo("/help")}.`
          );
      }
      rl.prompt();
      return;
    }

    // Free text -> treat as a task (interactive launch).
    await launchFromPrompt(rl, line);
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${c.dim("See you soon. ")}${c.indigo("›")}\n`);
    process.exit(0);
  });

  // Ctrl+C: confirm-style behavior — first clears line, prompt again.
  rl.on("SIGINT", () => {
    console.log(`\n${c.dim("(use /exit or Ctrl+D to quit)")}`);
    rl.prompt();
  });

  // Touch config so a fresh user has it.
  loadConfig();
}