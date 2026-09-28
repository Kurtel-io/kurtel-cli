import { cloudAllowed } from "../security/network.js";
import { accessGated, checkAccess } from "../storage/access.js";
import { accessRefusal } from "./access.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { Spinner } from "../ui/spinner.js";
import { buildIndex, renderReport } from "../graph/indexer.js";
import { repoRoot, headCommit } from "../repository/git.js";
import { saveIndex } from "../storage/graph-index.js";
import { pushIndex } from "../memory/api.js";
import { reportPath, projectConfigPath } from "../storage/paths.js";
import { saveModuleVectors } from "../storage/vectors.js";
import { activateRepo } from "../storage/state.js";
import { embeddingsAvailable, buildModuleVectors } from "../context/embeddings.js";
import { ensureWatcher } from "../runtime/reindex.js";
import { uninstallCommitHook } from "../integrations/git/hooks.js";

export interface OnboardOptions {
  json?: boolean;
  local?: boolean;
}

export async function onboardCommand(opts: OnboardOptions = {}): Promise<void> {
  const root = repoRoot();

  if (accessGated()) {
    const access = await checkAccess(root);
    if (!access?.active) {
      const message = accessRefusal(root, access);
      if (opts.json) process.stdout.write(JSON.stringify({ ok: false, reason: access?.reason ?? "unavailable", message }));
      else console.log(`${c.red(symbols.cross)} ${message}`);
      process.exitCode = 1;
      return;
    }
  }

  activateRepo(root);

  const spin = opts.json ? null : new Spinner("Indexing codebase (local, deterministic)…").start();
  const index = await buildIndex(root, (n) => {
    spin?.update(`Indexing codebase… ${n} files`);
  });
  saveIndex(root, index);
  spin?.succeed(`Indexed ${index.files_indexed} files · ${index.routes.length} routes · ${index.god_nodes.length} god nodes`);

  // Semantic vectors (cross-language zone selection); without them selection stays lexical.
  if (embeddingsAvailable()) {
    const mv = buildModuleVectors(index);
    if (mv) {
      saveModuleVectors(root, mv);
      if (!opts.json) console.log(`${symbols.check} Semantic vectors: ${mv.ids.length} modules embedded (${mv.dim}d)`);
    }
  }

  const report = renderReport(index, root);
  const rp = reportPath(root);
  const dir = join(root, ".kurtel");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(rp, report, "utf8");

  const cfg = projectConfigPath(root);
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ version: 1 }, null, 2) + "\n", "utf8");

  let uploaded = false;
  if (!opts.local && cloudAllowed()) {
    const spin2 = opts.json ? null : new Spinner("Uploading the graph to Kurtel cloud…").start();
    try { await pushIndex(root, index, headCommit(root)); uploaded = true; } catch { /* Offline or not signed in. */ }
    if (uploaded) spin2?.succeed("Graph uploaded");
    else spin2?.fail("Graph upload failed (offline or not signed in) — the graph works locally.");
  }

  // Continuous reindexing: the detached watcher keeps the graph current as code changes.
  ensureWatcher(root);

  // Remove the post-commit hook installed by earlier versions.
  uninstallCommitHook(root);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      repo: index.repo,
      branch: index.branch,
      files_indexed: index.files_indexed,
      routes: index.routes.length,
      god_nodes: index.god_nodes,
      domains: index.domains.slice(0, 10),
      report_path: rp,
      uploaded,
    }));
    return;
  }

  console.log("");
  console.log(`${c.indigoBold("Architecture snapshot")}`);
  console.log(`${c.gray("repo")}      ${c.white(index.repo)} ${c.dim(`(branch ${index.branch})`)}`);
  console.log(`${c.gray("domains")}   ${c.white(index.domains.slice(0, 6).map((d) => d.name).join(", "))}`);
  if (index.god_nodes.length) {
    console.log(`${c.gray("hotspots")}  ${index.god_nodes.slice(0, 3).map((g) => `${c.indigo(g.id)} ${c.dim(`(${g.degree} edges)`)}`).join("  ")}`);
  }
  console.log(`${c.gray("routes")}    ${c.white(String(index.routes.length))} ${c.dim("inventoried — duplicates will be flagged")}`);
  console.log("");
  console.log(`${symbols.check} Full report: ${c.indigo(rp)}`);
  console.log(`${c.dim("Graph")} ${c.indigo("active")}${c.dim(" — code locations are injected per task in Claude Code.")}`);
  console.log(`${c.dim("Live reindex")} ${c.indigo("on")}${c.dim(" — the graph follows your edits automatically (")}${c.indigo("kurtel watch status")}${c.dim(").")}`);
  console.log("");
}
