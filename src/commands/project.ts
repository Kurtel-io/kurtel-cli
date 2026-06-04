import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { getVersion } from "../lib/version.js";
import { loadConfig } from "../lib/config.js";

export async function initCommand(): Promise<void> {
  const dir = join(process.cwd(), ".kurtel");
  const file = join(dir, "config.json");

  if (existsSync(file)) {
    console.log(`${c.yellow(symbols.warn)} ${c.dim(".kurtel/config.json already exists.")}`);
    return;
  }

  const spin = new Spinner("Initializing Kurtel in this project…").start();
  await sleep(500);

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const template = {
    version: 1,
    engine: "kurtel-sota",
    sandbox: { isolated: true, ephemeral: true },
    review: { openPullRequests: true },
    learn: { shareTeamPatterns: true },
  };
  writeFileSync(file, JSON.stringify(template, null, 2) + "\n", "utf8");

  spin.succeed("Created .kurtel/config.json");
  console.log(
    `\n${c.dim("Next:")} ${c.indigo("kurtel login")} ${c.dim("then")} ${c.indigo(
      'kurtel run "your first task"'
    )}`
  );
}

export function doctorCommand(): void {
  const config = loadConfig();
  const checks: Array<[boolean, string]> = [
    [true, `Kurtel CLI v${getVersion()}`],
    [true, `Node.js ${process.version}`],
    [
      process.stdout.isTTY ?? false,
      `Interactive TTY ${process.stdout.isTTY ? "" : "(not detected — interactive mode limited)"}`,
    ],
    [config.loggedIn, config.loggedIn ? "Signed in" : "Not signed in (run: kurtel login)"],
    [false, "Cloud connectivity (preview — not yet enabled)"],
  ];

  console.log(`\n${c.indigoBold("Kurtel doctor")}\n`);
  for (const [ok, label] of checks) {
    const mark = ok ? symbols.check : c.yellow(symbols.warn);
    console.log(`  ${mark} ${ok ? c.white(label) : c.dim(label)}`);
  }
  console.log("");
}
