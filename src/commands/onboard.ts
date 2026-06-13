import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { Spinner } from "../ui/spinner.js";
import { buildIndex, renderReport } from "../memory/indexer.js";
import { repoRoot, saveIndex, reportPath, loadMemoryCache } from "../memory/store.js";
import { syncIndexUp, syncNow } from "../memory/sync.js";

export interface OnboardOptions {
  /** Sortie JSON compacte pour consommation par l'agent (slash command). */
  json?: boolean;
  /** Ne pas uploader le digest (mode 100% local). */
  local?: boolean;
}

export async function onboardCommand(opts: OnboardOptions = {}): Promise<void> {
  const root = repoRoot();

  // 1. Index structurel — local, déterministe, 0 token.
  const spin = opts.json ? null : new Spinner("Indexing codebase (local, deterministic)…").start();
  const index = await buildIndex(root, (n) => {
    if (spin) spin.text = `Indexing codebase… ${n} files`;
  });
  saveIndex(root, index);
  spin?.succeed(`Indexed ${index.files_indexed} files · ${index.routes.length} routes · ${index.god_nodes.length} god nodes`);

  // 2. Rapport d'audit — le livrable du jour 0.
  const report = renderReport(index);
  const rp = reportPath(root);
  const dir = join(root, ".kurtel");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(rp, report, "utf8");

  // 3. Sync: pull des patterns + push du digest pour l'app web.
  let uploaded = false;
  let patterns = 0;
  if (!opts.local) {
    const spin2 = opts.json ? null : new Spinner("Syncing memory with Kurtel cloud…").start();
    uploaded = await syncIndexUp(root);
    try {
      const r = await syncNow(root);
      patterns = loadMemoryCache(root).patterns.length;
      void r;
    } catch { /* offline ok */ }
    if (spin2) {
      if (uploaded) spin2.succeed(`Memory synced · ${patterns} team patterns pulled`);
      else spin2.fail("Cloud sync failed (offline or not signed in) — memory works locally; run `kurtel memory sync` later.");
    }
  }

  if (opts.json) {
    // Sortie machine pour le slash command /kurtel:onboard — l'agent lit ce JSON
    // et présente le rapport à l'utilisateur dans la session.
    process.stdout.write(JSON.stringify({
      ok: true,
      repo: index.repo,
      files_indexed: index.files_indexed,
      routes: index.routes.length,
      god_nodes: index.god_nodes,
      domains: index.domains.slice(0, 10),
      report_path: rp,
      uploaded,
      patterns_loaded: patterns,
    }));
    return;
  }

  // Affichage humain
  console.log("");
  console.log(`${c.indigoBold("Architecture snapshot")}`);
  console.log(`${c.gray("repo")}      ${c.white(index.repo)}`);
  console.log(`${c.gray("domains")}   ${c.white(index.domains.slice(0, 6).map((d) => d.name).join(", "))}`);
  if (index.god_nodes.length) {
    console.log(`${c.gray("hotspots")}  ${index.god_nodes.slice(0, 3).map((g) => `${c.indigo(g.id)} ${c.dim(`(${g.degree} edges)`)}`).join("  ")}`);
  }
  console.log(`${c.gray("routes")}    ${c.white(String(index.routes.length))} ${c.dim("inventoried — duplicates will be flagged")}`);
  console.log("");
  console.log(`${symbols.check} Full report: ${c.indigo(rp)}`);
  console.log(`${c.dim("Memory is now")} ${c.indigo("active")}${c.dim(" — context is injected per task in Claude Code.")}`);
  console.log("");
}
