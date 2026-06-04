import * as readline from "node:readline";
import { c, symbols } from "../ui/colors.js";
import { banner, welcomeBox } from "../ui/banner.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { loadConfig } from "../lib/config.js";
import { agentsCommand } from "../commands/agents.js";
import { loginCommand } from "../commands/auth.js";
import { configCommand } from "../commands/config.js";
import { previewNotice } from "../commands/_shared.js";

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

async function launchFromPrompt(task: string): Promise<void> {
  const id = "agent-" + Math.random().toString(16).slice(2, 6);
  const spin = new Spinner("Provisioning sandbox & booting agent…").start();
  await sleep(700);
  spin.update("Planning approach…");
  await sleep(700);
  spin.succeed(`Queued ${c.indigo(id)} for: ${c.white(task)}`);
  previewNotice("Launching agents");
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
          rl.pause();
          if (!arg) {
            console.log(
              `${c.red(symbols.cross)} Usage: ${c.indigo("/run <task>")}`
            );
          } else {
            await launchFromPrompt(arg);
          }
          rl.resume();
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

    // Free text -> treat as a task
    rl.pause();
    await launchFromPrompt(line);
    rl.resume();
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
