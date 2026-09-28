import { c, symbols } from "../ui/colors.js";
import { repoRoot } from "../repository/git.js";
import { originRemote } from "../repository/remote.js";
import { checkAccess, chooseOrganization, type AccessEntry } from "../storage/access.js";

/** Why Kurtel is off in this folder, in plain words. */
export function accessRefusal(root: string, entry: AccessEntry | null): string {
  const remote = originRemote(root);
  if (!remote) return "Kurtel is off: this folder has no network origin remote (git remote get-url origin), so it cannot match a repository declared by your organization.";
  switch (entry?.reason) {
    case "not_signed_in": return "Kurtel is off: sign in with kurtel login.";
    case "not_declared": return `Kurtel is off: ${remote} is not declared by any of your organizations. An owner or admin declares it in Repositories on kurtel.io.`;
    case "no_access": return `Kurtel is off: ${remote} is declared by ${entry.organization?.name ?? "your organization"}, but you have no access to it. An owner or admin gives it in Access on kurtel.io.`;
    case "organization_required": return `Kurtel is off: ${remote} is declared in several of your organizations (${(entry.organizations ?? []).map(o => o.slug).join(", ")}). Choose one with kurtel org use <slug>.`;
    case "invalid_remote": return `Kurtel is off: ${remote} is not a repository URL Kurtel recognizes.`;
    default: return "Kurtel could not reach kurtel.io to check your access to this repository. It will ask again at the next session.";
  }
}

function describe(root: string, entry: AccessEntry | null, json?: boolean): void {
  if (json) { process.stdout.write(JSON.stringify(entry ?? { remote: originRemote(root), active: false, reason: "unavailable" }) + "\n"); return; }
  if (entry?.active) {
    console.log(`${c.green(symbols.check)} Kurtel is on for ${c.white(entry.remote)} · ${c.white(entry.organization?.name ?? "")} ${c.dim(`(${entry.organization?.slug}, ${entry.role})`)}`);
    return;
  }
  console.log(`${c.red(symbols.cross)} ${accessRefusal(root, entry)}`);
}

/** kurtel access: asks kurtel.io whether this repository is declared and accessible, and keeps the answer. */
export async function accessCommand(opts: { quiet?: boolean; json?: boolean } = {}): Promise<void> {
  const root = repoRoot();
  const entry = await checkAccess(root);
  if (!opts.quiet) describe(root, entry, opts.json);
  if (!entry?.active) process.exitCode = 1;
}

/** kurtel org use <slug>: which organization this folder uses when the repository is declared in several. */
export async function orgCommand(action: string | undefined, value: string | undefined, opts: { json?: boolean } = {}): Promise<void> {
  const root = repoRoot();
  if (action === "use") {
    if (!value) { console.log(`${c.red(symbols.cross)} Usage: kurtel org use <organization slug>`); process.exitCode = 1; return; }
    chooseOrganization(root, value);
    const entry = await checkAccess(root);
    describe(root, entry, opts.json);
    if (!entry?.active) process.exitCode = 1;
    return;
  }
  if (action && action !== "status") { console.log(`${c.red(symbols.cross)} Unknown action ${c.white(action)}. Try ${c.indigo("kurtel org")} or ${c.indigo("kurtel org use <slug>")}.`); process.exitCode = 1; return; }
  describe(root, await checkAccess(root), opts.json);
}
