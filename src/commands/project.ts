import { networkPolicy, policyPath } from "../security/network.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { getVersion } from "../lib/version.js";
import { loadConfig } from "../lib/config.js";
import { repoRoot } from "../repository/git.js";
import { activateRepo } from "../storage/state.js";

export async function initCommand(): Promise<void> {
  const root = repoRoot();
  const dir = join(root, ".kurtel");
  const file = join(dir, "config.json");

  if (existsSync(file)) {
    activateRepo(root); // the marker is enough; keeps the local state in line
    console.log(`${c.yellow(symbols.warn)} ${c.dim(".kurtel/config.json already exists.")}`);
    return;
  }

  const spin = new Spinner("Initializing Kurtel in this project…").start();
  await sleep(500);

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const template = { version: 1 };
  writeFileSync(file, JSON.stringify(template, null, 2) + "\n", "utf8");
  activateRepo(root); // init activates the Claude Code hooks here

  spin.succeed("Created .kurtel/config.json");
  console.log(
    `\n${c.dim("Next:")} ${c.indigo("kurtel login")} ${c.dim("then")} ${c.indigo(
      "kurtel onboard"
    )}`
  );
}

export function doctorCommand(): void {
  const config = loadConfig();
  const policy = networkPolicy();
  const checks: Array<[boolean, string]> = [
    [true, `Kurtel CLI v${getVersion()}`],
    [true, `Node.js ${process.version}`],
    [true, `Network: ${policy.mode} (${policyPath()})`],
    [
      process.stdout.isTTY ?? false,
      `Interactive TTY ${process.stdout.isTTY ? "" : "(not detected — interactive mode limited)"}`,
    ],
    [policy.mode !== "cloud" || config.loggedIn, policy.mode !== "cloud" ? "Private/local mode: cloud login unnecessary" : config.loggedIn ? "Signed in" : "Not signed in (run: kurtel login)"],
  ];

  console.log(`\n${c.indigoBold("Kurtel doctor")}\n`);
  for (const [ok, label] of checks) {
    const mark = ok ? symbols.check : c.yellow(symbols.warn);
    console.log(`  ${mark} ${ok ? c.white(label) : c.dim(label)}`);
  }
  console.log("");
}
