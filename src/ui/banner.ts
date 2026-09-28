import { c, symbols } from "./colors.js";
import { box } from "./box.js";
import { getVersion } from "../lib/version.js";

const wordmark = [
  " _  __          _       _ ",
  "| |/ /   _ _ __| |_ ___| |",
  "| ' / | | | '__| __/ _ \\ |",
  "| . \\ |_| | |  | ||  __/ |",
  "|_|\\_\\__,_|_|   \\__\\___|_|",
];

export function banner(): string {
  const art = wordmark.map((l) => c.indigoBold(l)).join("\n");
  const tag = c.gray("  codebase graph and team memory");
  const ver = c.dim(`  v${getVersion()}`);
  return `\n${art}\n${tag}${ver}\n`;
}

export function welcomeBox(cwd: string): string {
  const lines = [
    `${c.indigo(symbols.arrow)} ${c.bold("Welcome to Kurtel")} ${c.dim("(preview)")}`,
    "",
    `${c.gray("cwd")}    ${c.white(cwd)}`,
    "",
    `${c.dim("Explore your graph and memory with")} ${c.indigo("/help")} ${c.dim("for commands.")}`,
    `${c.dim("Exit with")} ${c.indigo("/exit")} ${c.dim("or Ctrl+D.")}`,
  ];
  return box(lines, { borderColor: c.indigo, padding: 1 });
}
