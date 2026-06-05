import { c, symbols } from "../ui/colors.js";
import { sleep } from "../ui/spinner.js";
import { getRun, getRunLogs, cancelRun, AuthError } from "../lib/api.js";

function handleErr(e: unknown): void {
  if (e instanceof AuthError) console.log(`${c.red(symbols.cross)} ${e.message}`);
  else console.log(`${c.red(symbols.cross)} ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return c.indigo("● running");
    case "queued": return c.gray("○ queued");
    case "succeeded": return c.green("✔ succeeded");
    case "failed": return c.red("✖ failed");
    case "canceled": return c.yellow("• canceled");
    default: return status;
  }
}

const TERMINAL = ["succeeded", "failed", "canceled"];

export async function logsCommand(
  id: string,
  opts: { follow?: boolean } = {}
): Promise<void> {
  try {
    let printed = 0;
    for (;;) {
      const { status, logs } = await getRunLogs(id);
      if (logs.length > printed) {
        process.stdout.write(logs.slice(printed));
        printed = logs.length;
      }
      if (!opts.follow || TERMINAL.includes(status)) {
        console.log(`\n${statusLabel(status)}`);
        return;
      }
      await sleep(1500);
    }
  } catch (e) {
    handleErr(e);
  }
}

export async function statusCommand(id: string): Promise<void> {
  try {
    const run = await getRun(id);
    console.log("");
    console.log(`${c.gray("id")}       ${c.indigo(run.id)}`);
    console.log(`${c.gray("task")}     ${c.white(run.task)}`);
    if (run.repo) console.log(`${c.gray("repo")}     ${c.white(run.repo)}`);
    console.log(`${c.gray("engine")}   ${c.white(run.engine)}`);
    if (run.model) console.log(`${c.gray("model")}    ${c.white(run.model)}`);
    console.log(`${c.gray("status")}   ${statusLabel(run.status)}`);
    if (run.result?.summary) console.log(`${c.gray("summary")}  ${c.white(run.result.summary)}`);
    if (run.error) console.log(`${c.gray("error")}    ${c.red(run.error)}`);
    console.log("");
  } catch (e) {
    handleErr(e);
  }
}

export async function stopCommand(id: string): Promise<void> {
  try {
    await cancelRun(id);
    console.log(`${symbols.check} Canceled ${c.indigo(id)} ${c.dim("· sandbox torn down")}`);
  } catch (e) {
    handleErr(e);
  }
}