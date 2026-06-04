import { c, symbols } from "./colors.js";
import { box } from "./box.js";
import { getVersion } from "../lib/version.js";

const wordmark = [
  "  _  __         _       _ ",
  " | |/ /  _ _ _ | |_ ___| |",
  " | ' <  | '_| || |  _/ -_) |",
  " |_|\\_\\ |_|  \\_,_|\\__\\___|_|",
];

export function banner(): string {
  const art = wordmark.map((l) => c.indigoBold(l)).join("\n");
  const tag = c.gray("  self-improving coding agents in the cloud");
  const ver = c.dim(`  v${getVersion()}`);
  return `\n${art}\n${tag}${ver}\n`;
}

export function welcomeBox(cwd: string, model: string): string {
  const lines = [
    `${c.indigo(symbols.arrow)} ${c.bold("Welcome to Kurtel")} ${c.dim("(preview)")}`,
    "",
    `${c.gray("cwd")}    ${c.white(cwd)}`,
    `${c.gray("engine")} ${c.white(model)}`,
    `${c.gray("status")} ${c.yellow("● not connected")} ${c.dim("— commands are stubs for now")}`,
    "",
    `${c.dim("Type a task to launch an agent, or")} ${c.indigo("/help")} ${c.dim("for commands.")}`,
    `${c.dim("Exit with")} ${c.indigo("/exit")} ${c.dim("or Ctrl+D.")}`,
  ];
  return box(lines, { borderColor: c.indigo, padding: 1 });
}
