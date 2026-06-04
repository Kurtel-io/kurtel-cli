import { c, symbols } from "../ui/colors.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { previewNotice } from "./_shared.js";

export interface RunOptions {
  repo?: string;
  branch?: string;
  detach?: boolean;
}

export async function runCommand(
  task: string | undefined,
  opts: RunOptions
): Promise<void> {
  if (!task || task.trim() === "") {
    console.log(
      `${c.red(symbols.cross)} Provide a task, e.g. ${c.indigo(
        'kurtel run "fix flaky auth test"'
      )}`
    );
    process.exitCode = 1;
    return;
  }

  const id = "agent-" + Math.random().toString(16).slice(2, 6);
  const repo = opts.repo ?? "(current repo)";

  console.log("");
  console.log(`${c.gray("task")}   ${c.white(task)}`);
  console.log(`${c.gray("repo")}   ${c.white(repo)}`);
  console.log(`${c.gray("branch")} ${c.white(opts.branch ?? "main")}`);
  console.log("");

  const spin = new Spinner("Provisioning isolated sandbox…").start();
  await sleep(700);
  spin.update("Booting agent (codex + claude-code)…");
  await sleep(700);
  spin.update("Cloning repository into sandbox…");
  await sleep(600);
  spin.succeed(`Launched ${c.indigo(id)} ${c.dim(`(${opts.detach ? "detached" : "attached"})`)}`);

  console.log("");
  previewNotice("Launching agents");
  console.log(
    `${c.dim("Once connected, follow it with")} ${c.indigo(
      `kurtel logs ${id}`
    )}${c.dim(".")}`
  );
}
