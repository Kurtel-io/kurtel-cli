import * as readline from "node:readline";
import { c, symbols } from "../ui/colors.js";
import { banner, welcomeBox } from "../ui/banner.js";
import { loginCommand } from "../commands/auth.js";
import { configCommand } from "../commands/config.js";
import { onboardCommand } from "../commands/onboard.js";
import { memoryCommand } from "../commands/memory.js";
import { impactCommand } from "../commands/impact.js";

const commands = ["/help", "/onboard", "/status", "/memory", "/impact", "/login", "/config", "/clear", "/exit"];
export async function startSession(): Promise<void> {
  console.log(banner());
  console.log(welcomeBox(process.cwd()));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout,
    prompt: `${c.indigo("kurtel")} ${symbols.arrow} `,
    completer: (line: string) => [commands.filter(cmd => cmd.startsWith(line)), line],
  });
  rl.prompt();
  for await (const input of rl) {
    const [cmd, ...args] = input.trim().split(/\s+/);
    const arg = args.join(" ");
    try {
      switch (cmd) {
        case "": break;
        case "/exit": case "/quit": rl.close(); return;
        case "/clear": console.clear(); console.log(banner()); break;
        case "/onboard": await onboardCommand({ local: args.includes("--local") }); break;
        case "/status": await memoryCommand("status", {}); break;
        case "/memory": await memoryCommand(args[0] || "status", { global: args.includes("--global") }, args.slice(1).filter(a => a !== "--global")); break;
        case "/impact": await impactCommand(arg, {}); break;
        case "/login": await loginCommand(); break;
        case "/config": configCommand("list"); break;
        default:
          console.log(commands.join("  "));
          console.log("Use /memory preview <prompt> to inspect context or /impact <file> for dependencies.");
      }
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    rl.prompt();
  }
}
