import { c, symbols } from "../ui/colors.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { SAMPLE_AGENTS, statusColor, levelBadge } from "../lib/agents.js";
import { previewNotice } from "./_shared.js";

function findAgent(id: string) {
  return SAMPLE_AGENTS.find((a) => a.id === id) ?? SAMPLE_AGENTS[0];
}

const FAKE_LOG_LINES = [
  ["plan", "Reading repository structure and conventions"],
  ["plan", "Drafting change set across 4 files"],
  ["edit", "src/webhooks/handler.ts — add idempotency guard"],
  ["test", "Running test suite in sandbox"],
  ["learn", "Captured pattern: prefer repository-scoped idempotency keys"],
  ["done", "Opened pull request #482"],
] as const;

export async function logsCommand(id: string): Promise<void> {
  const agent = findAgent(id);
  console.log(
    `\n${c.dim("Streaming logs for")} ${c.indigo(agent.id)} ${c.dim(
      `· ${agent.repo}`
    )}\n`
  );

  for (const [tag, msg] of FAKE_LOG_LINES) {
    const ts = c.dim(new Date().toLocaleTimeString());
    const label =
      tag === "learn"
        ? c.cyan(`[${tag}]`)
        : tag === "done"
        ? c.green(`[${tag}]`)
        : c.indigo(`[${tag}]`);
    console.log(`${ts} ${label} ${c.white(msg)}`);
    await sleep(450);
  }

  console.log("");
  previewNotice("Live logs");
}

export function statusCommand(id: string): void {
  const a = findAgent(id);
  console.log("");
  console.log(`${c.gray("id")}       ${c.indigo(a.id)}`);
  console.log(`${c.gray("task")}     ${c.white(a.task)}`);
  console.log(`${c.gray("repo")}     ${c.white(a.repo)}`);
  console.log(`${c.gray("level")}    ${levelBadge(a.level)}`);
  console.log(`${c.gray("status")}   ${statusColor(a.status)}`);
  console.log(`${c.gray("progress")} ${c.white(a.progress + "%")}`);
  console.log("");
  previewNotice("Agent status");
}

export async function stopCommand(id: string): Promise<void> {
  const a = findAgent(id);
  const spin = new Spinner(`Stopping ${c.indigo(a.id)} and tearing down sandbox…`).start();
  await sleep(800);
  spin.succeed(`Stopped ${c.indigo(a.id)} ${c.dim("· sandbox destroyed")}`);
  previewNotice("Stopping agents");
}
