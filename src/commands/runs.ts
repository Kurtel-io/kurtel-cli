import { c } from "../ui/colors.js";
import { listRuns, AuthError, type Run } from "../lib/api.js";

function pad(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const len = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, width - len));
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return c.indigo("● running");
    case "queued": return c.gray("○ queued");
    case "succeeded": return c.green("✔ done");
    case "failed": return c.red("✖ failed");
    case "canceled": return c.yellow("• canceled");
    default: return status;
  }
}

function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function runsCommand(): Promise<void> {
  try {
    const { runs } = await listRuns();
    if (!runs.length) {
      console.log(c.dim("No runs yet. Launch one with `kurtel run \"…\"`."));
      return;
    }
    console.log("");
    console.log(
      pad(c.gray("ID"), 14) + pad(c.gray("STATUS"), 14) +
      pad(c.gray("ENGINE"), 14) + pad(c.gray("AGE"), 10) + c.gray("TASK")
    );
    for (const r of runs as Run[]) {
      console.log(
        pad(c.indigo(r.id), 14) + pad(statusLabel(r.status), 14) +
        pad(c.dim(r.engine), 14) + pad(c.dim(ago(r.created_at)), 10) +
        c.white(r.task.length > 50 ? r.task.slice(0, 49) + "…" : r.task)
      );
    }
    console.log("");
  } catch (e) {
    if (e instanceof AuthError) console.log(`${c.red("✖")} ${e.message}`);
    else console.log(`${c.red("✖")} ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}