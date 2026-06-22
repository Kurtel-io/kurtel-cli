import * as readline from "node:readline";
import { c, symbols } from "../ui/colors.js";
import { banner, welcomeBox } from "../ui/banner.js";
import { loadConfig } from "../lib/config.js";
import { isEngineName } from "../lib/engines.js";
import { repoRoot, repoFullName, currentBranch } from "../memory/store.js";
import { agentsCommand } from "../commands/agents.js";
import { loginCommand } from "../commands/auth.js";
import { configCommand } from "../commands/config.js";
import { runCommand } from "../commands/run.js";
import { runsCommand } from "../commands/runs.js";
import { logsCommand, statusCommand, stopCommand } from "../commands/runtime.js";

const SLASH_COMMANDS: Array<[string, string]> = [
  ["/help", "Show this help"],
  ["/run <task>", "Launch a cloud agent on a task"],
  ["/runs", "List your recent runs"],
  ["/logs [id]", "Stream a run's logs (defaults to the last one)"],
  ["/status [id]", "Show a run's status & result"],
  ["/stop [id]", "Cancel a run and tear down its sandbox"],
  ["/agents", "List active agents"],
  ["/login", "Sign in to Kurtel"],
  ["/config", "Show local configuration"],
  ["/clear", "Clear the screen"],
  ["/exit", "Quit the session"],
];

// Remember the most recently launched run so `/logs` and `/status` can default
// to it without making the user paste an id.
let lastRunId: string | null = null;

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

let asking = false;

function ask(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => resolve(answer.trim()));
  });
}

async function launchFromPrompt(
  rl: readline.Interface,
  task: string
): Promise<void> {
  const cfg = loadConfig();
  // Défauts déduits du git courant (cohérent avec `kurtel run`): repo = remote
  // origin, branche = branche courante. On retombe sur la config / "main" sinon.
  const root = repoRoot();
  const inferredRepo = repoFullName(root);
  const defRepo = inferredRepo.includes("/") ? inferredRepo : "";
  const defBranch = currentBranch(root) || cfg.defaultBranch || "main";
  // cfg.engine peut valoir un libellé non-engine (ex. "kurtel-sota (…)"): on ne
  // l'utilise comme défaut que s'il est un engine valide, sinon claude-code.
  const defEngine = isEngineName(String(cfg.engine)) ? String(cfg.engine) : "claude-code";

  let repo = defRepo;
  let branch = defBranch;
  let engine = defEngine;
  let model = "";

  asking = true;
  try {
    console.log("");
    repo =
      (await ask(
        rl,
        `  ${c.gray("repo")}    ${c.dim(defRepo ? `(default ${defRepo}, "-" for none)` : "(owner/name, empty for none)")} ${c.indigo(symbols.arrow)} `
      )) || defRepo;
    // "-" = forcer aucun repo malgré le défaut git.
    if (repo === "-") repo = "";
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

  // noResolve: le REPL a déjà tout demandé via SON readline — runCommand ne doit
  // ni re-prompter (2e readline = conflit) ni ré-appliquer de défaut.
  const id = await runCommand(task, {
    repo: repo || undefined,
    branch,
    engine,
    model: model || undefined,
    noResolve: true,
  });

  if (id) {
    lastRunId = id;
    console.log(
      `${c.dim("In here:")} ${c.indigo("/logs")} ${c.dim("to watch ·")} ${c.indigo("/runs")} ${c.dim("to list")}`
    );
  }
}

function resolveId(arg: string): string | null {
  if (arg) return arg;
  if (lastRunId) return lastRunId;
  console.log(
    `${c.red(symbols.cross)} No run id given and no recent run. Try ${c.indigo("/runs")}.`
  );
  return null;
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
        case "runs":
        case "ls":
          rl.pause();
          await runsCommand();
          rl.resume();
          break;
        case "logs": {
          const id = resolveId(arg);
          if (id) {
            rl.pause();
            await logsCommand(id, { follow: true });
            rl.resume();
          }
          break;
        }
        case "status": {
          const id = resolveId(arg);
          if (id) {
            rl.pause();
            await statusCommand(id);
            rl.resume();
          }
          break;
        }
        case "stop": {
          const id = resolveId(arg);
          if (id) {
            rl.pause();
            await stopCommand(id);
            rl.resume();
          }
          break;
        }
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

    await launchFromPrompt(rl, line);
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${c.dim("See you soon. ")}${c.indigo("›")}\n`);
    process.exit(0);
  });

  rl.on("SIGINT", () => {
    console.log(`\n${c.dim("(use /exit or Ctrl+D to quit)")}`);
    rl.prompt();
  });

  loadConfig();
}