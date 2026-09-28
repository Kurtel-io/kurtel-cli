import { c, symbols } from "../ui/colors.js";
import { repoRoot } from "../repository/git.js";
import { memoryEnabled, setKurtelEnabled } from "../storage/state.js";
import { accessGated, activeAccess } from "../storage/access.js";

/**
 * kurtel on | off: Kurtel entirely on or off in this repository, graph included. Memory alone is
 * kurtel memory on | off; the organization's plan decides whether memory is included at all.
 */
export function switchCommand(on: boolean): void {
  const root = repoRoot();
  setKurtelEnabled(root, on);
  if (!on) {
    console.log(`${symbols.check} Kurtel ${c.yellow("off")} in this repository ${c.dim("(no graph, no memory; hooks stay installed and stay silent — kurtel on to turn it back on)")}.`);
    return;
  }
  console.log(`${symbols.check} Kurtel ${c.indigo("on")} in this repository${memoryEnabled(root) ? " · graph and memory" : " · graph"}.`);
  if (accessGated() && !activeAccess(root)) console.log(c.dim("It works once this repository is declared by your organization and you have access to it (kurtel access)."));
}
