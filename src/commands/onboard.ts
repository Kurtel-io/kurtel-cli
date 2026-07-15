import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { c, symbols } from "../ui/colors.js";
import { Spinner } from "../ui/spinner.js";
import { buildIndex, renderReport } from "../memory/indexer.js";
import { repoRoot, saveIndex, reportPath, loadMemoryCache, saveModuleVectors, repoFullName, activateRepo, projectConfigPath } from "../memory/store.js";
import { embeddingsAvailable, buildModuleVectors } from "../memory/embed.js";
import { syncIndexUp, syncNow } from "../memory/sync.js";
import { ensureWatcher } from "../memory/reindex.js";
import { installCommitHook } from "../memory/githook.js";
import { collectSkillDocs } from "../memory/skills.js";
import { pushSkills } from "../memory/api.js";
import { loadConfig } from "../lib/config.js";

export interface OnboardOptions {
  /** Sortie JSON compacte pour consommation par l'agent (slash command). */
  json?: boolean;
  /** Ne pas uploader le digest (mode 100% local). */
  local?: boolean;
}

export async function onboardCommand(opts: OnboardOptions = {}): Promise<void> {
  const root = repoRoot();

  // Onboard = LE geste d'opt-in. Sans lui (ou `kurtel init` / `kurtel memory on`),
  // hooks et watcher restent muets partout. Marqueur versionnable + flag local.
  activateRepo(root);

  const spin = opts.json ? null : new Spinner("Indexing codebase (local, deterministic)…").start();
  const index = await buildIndex(root, (n) => {
    spin?.update(`Indexing codebase… ${n} files`);
  });
  saveIndex(root, index);
  spin?.succeed(`Indexed ${index.files_indexed} files · ${index.routes.length} routes · ${index.god_nodes.length} god nodes`);

  // Vecteurs sémantiques (pont FR→EN pour la sélection de zones) — sinon la capsule reste lexicale.
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

  // Marqueur d'activation dans le repo (versionnable: un teammate qui clone est
  // activé d'office). Ne jamais écraser un config.json existant (kurtel init).
  const cfg = projectConfigPath(root);
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ version: 1 }, null, 2) + "\n", "utf8");

  let uploaded = false;
  let patterns = 0;
  let skillsImported = 0;
  if (!opts.local) {
    const spin2 = opts.json ? null : new Spinner("Syncing memory with Kurtel cloud…").start();
    uploaded = await syncIndexUp(root);

    // Import des skills écrits à la main → patterns (UNIQUEMENT si connecté).
    // Non connecté = on ne fait que le graphe. Best-effort, jamais bloquant.
    // Placé AVANT le pull pour que les patterns importés redescendent dans le cache.
    if (loadConfig().token) {
      try {
        const docs = collectSkillDocs(root);
        if (docs.length) {
          spin2?.update(`Importing ${docs.length} existing skill doc(s)…`);
          const r = await pushSkills(repoFullName(root), docs);
          skillsImported = r.imported ?? 0;
        }
      } catch { /* offline / not signed in: skip silently */ }
    }

    try {
      const r = await syncNow(root);
      patterns = loadMemoryCache(root).patterns.length;
      void r;
    } catch { /* offline ok */ }
    if (spin2) {
      if (uploaded) {
        const extra = skillsImported ? ` · ${skillsImported} imported from your skills` : "";
        spin2.succeed(`Memory synced · ${patterns} team patterns pulled${extra}`);
      } else {
        spin2.fail("Cloud sync failed (offline or not signed in) — memory works locally; run `kurtel memory sync` later.");
      }
    }
  }

  // Réindexation continue: démarre le watcher détaché pour que le graphe reste
  // juste même quand l'utilisateur code à la main, sans jamais relancer onboard.
  ensureWatcher(root);

  // Apprentissage à chaque commit, quel que soit l'outil (Claude Code, Codex, ou
  // aucun agent): un hook git post-commit, indépendant du daemon.
  const hookInstalled = installCommitHook(root);

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
      patterns_loaded: patterns,
      skills_imported: skillsImported,
      auto_learn: hookInstalled,
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
  console.log(`${c.dim("Memory is now")} ${c.indigo("active")}${c.dim(" — context is injected per task in Claude Code.")}`);
  console.log(`${c.dim("Live reindex")} ${c.indigo("on")}${c.dim(" — the graph follows your edits automatically (")}${c.indigo("kurtel watch status")}${c.dim(").")}`);
  if (hookInstalled) {
    console.log(`${c.dim("Auto-learn")} ${c.indigo("on")}${c.dim(" — every commit teaches Kurtel, with any tool (no agent required).")}`);
  }
  console.log("");
}
