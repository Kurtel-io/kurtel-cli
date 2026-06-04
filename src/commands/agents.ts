import { c } from "../ui/colors.js";
import {
  SAMPLE_AGENTS,
  statusColor,
  levelBadge,
  type Agent,
} from "../lib/agents.js";
import { previewNotice } from "./_shared.js";

function pad(s: string, width: number): string {
  // pad based on visible length (strip ANSI)
  // eslint-disable-next-line no-control-regex
  const len = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, width - len));
}

export function agentsCommand(): void {
  console.log("");
  const header =
    pad(c.gray("ID"), 12) +
    pad(c.gray("LEVEL"), 9) +
    pad(c.gray("STATUS"), 14) +
    pad(c.gray("AGE"), 7) +
    c.gray("TASK");
  console.log(header);

  for (const a of SAMPLE_AGENTS as Agent[]) {
    const row =
      pad(c.indigo(a.id), 12) +
      pad(levelBadge(a.level), 9) +
      pad(statusColor(a.status), 14) +
      pad(c.dim(a.age), 7) +
      c.white(a.task);
    console.log(row);
  }

  console.log("");
  previewNotice("Listing agents");
}
