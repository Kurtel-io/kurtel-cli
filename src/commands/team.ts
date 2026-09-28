import { readFileSync, statSync } from "node:fs";
import { repoRoot } from "../repository/git.js";
import { bindTeam, unbindTeam, preparePublication, teamOperation } from "../memory/team.js";

export async function teamCommand(action: string, value: string | undefined, options: { team?: string; repo?: string; since?: string }) {
  const root = repoRoot();
  if (action === "connect") {
    if (!options.team || !options.repo) throw new Error("Use team connect --team <id> --repo <name>");
    await bindTeam(root, options.team, options.repo); console.log("Team connected; conversations stay private."); return;
  }
  if (action === "disconnect") { unbindTeam(root); console.log("Team disconnected."); return; }
  if (action === "prepare") {
    if (!value) throw new Error("Use team prepare <local-version-id>");
    console.log(JSON.stringify(preparePublication(root, value), null, 2)); return;
  }
  if (action === "publish") {
    if (!value || statSync(value).size > 35000) throw new Error("Use team publish <reviewed.json> (at most 35 KB)");
    const publication = JSON.parse(readFileSync(value, "utf8"));
    console.log(JSON.stringify(await teamOperation(root, { action, publication }), null, 2)); return;
  }
  if (action === "history" || action === "erase") {
    if (!value) throw new Error(`Use team ${action} <shared-knowledge-id>`);
    console.log(JSON.stringify(await teamOperation(root, { action, id: value }), null, 2)); return;
  }
  if (action === "sync") {
    console.log(JSON.stringify(await teamOperation(root, { action, since: Number(options.since ?? 0) }), null, 2)); return;
  }
  throw new Error("Use team connect | disconnect | prepare | publish | sync | history | erase");
}
