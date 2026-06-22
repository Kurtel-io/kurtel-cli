import { c, symbols } from "../ui/colors.js";
import { createRun, AuthError } from "../lib/api.js";
import { isEngineName, ENGINE_NAMES } from "../lib/engines.js";
import { repoRoot, repoFullName, currentBranch } from "../memory/store.js";
import { isInteractive, ask, select } from "../ui/prompt.js";

export interface RunOptions {
  repo?: string;
  branch?: string;
  engine?: string;
  model?: string;
  /**
   * L'appelant a DÉJÀ résolu repo/branch/engine (ex. la session REPL, qui fait
   * son propre prompt via son readline). On utilise alors les valeurs telles
   * quelles: ni prompt ni défaut. Ouvrir un 2ᵉ readline ici re-demanderait le
   * repo et entrerait en conflit avec celui de l'appelant.
   */
  noResolve?: boolean;
}

export async function runCommand(
  task: string | undefined,
  opts: RunOptions
): Promise<string | undefined> {
  if (!task || task.trim() === "") {
    console.log(
      `${c.red(symbols.cross)} Provide a task, e.g. ${c.indigo(
        'kurtel run "fix the flaky auth test"'
      )}`
    );
    process.exitCode = 1;
    return undefined;
  }

  if (opts.engine && !isEngineName(opts.engine)) {
    console.log(
      `${c.red(symbols.cross)} Unknown engine ${c.white(opts.engine)}. Use ${c.indigo(
        "claude-code"
      )} or ${c.indigo("codex")}.`
    );
    process.exitCode = 1;
    return undefined;
  }

  // ── Résolution repo / branch / engine ───────────────────────────────────────
  // Priorité: flag explicite > prompt interactif (TTY) > défaut déduit du git
  // courant. Hors TTY (pipe / CI) on ne prompte jamais — on retombe sur les
  // défauts git pour ne pas bloquer. C'est ce qui manquait: avant, sans flags,
  // le run partait avec repo=null / branch=main sans rien demander ni déduire.
  // noResolve: l'appelant (REPL) a déjà tout résolu → on n'y touche pas.
  let repo = opts.repo?.trim() || undefined;
  let branch = opts.branch?.trim() || undefined;
  let engine = opts.engine?.trim() || undefined;

  if (!opts.noResolve) {
    const root = repoRoot();
    const inferredRepo = repoFullName(root);
    // repoFullName retombe sur le nom du dossier s'il n'y a pas de remote: ce
    // n'est un slug valide que s'il contient "owner/name".
    const repoDefault = inferredRepo.includes("/") ? inferredRepo : undefined;
    const branchDefault = currentBranch(root);

    if (isInteractive()) {
      if (!repo) repo = (await ask("Repo (owner/name)", repoDefault)).trim() || undefined;
      if (!branch) branch = (await ask("Base branch", branchDefault)).trim() || undefined;
      if (!engine) engine = await select("Engine", [...ENGINE_NAMES], 0);
    } else {
      repo = repo ?? repoDefault;
      branch = branch ?? branchDefault;
      // engine non fourni: laissé au backend (défaut claude-code).
    }
  }

  try {
    const run = await createRun({
      task,
      repo,
      branch,
      engine,
      model: opts.model,
    });

    console.log("");
    console.log(`${symbols.check} Launched ${c.indigo(run.id)}`);
    console.log(`${c.gray("task")}    ${c.white(run.task)}`);
    console.log(`${c.gray("engine")}  ${c.white(run.engine)}`);
    if (run.model) console.log(`${c.gray("model")}   ${c.white(run.model)}`);
    if (run.repo) console.log(`${c.gray("repo")}    ${c.white(run.repo)}`);
    console.log(`${c.gray("status")}  ${c.indigo(run.status)}`);
    console.log("");
    console.log(
      `${c.dim("Follow it with")} ${c.indigo(`kurtel logs ${run.id} --follow`)}`
    );
    return run.id;
  } catch (e) {
    if (e instanceof AuthError) {
      console.log(`${c.red(symbols.cross)} ${e.message}`);
    } else {
      console.log(
        `${c.red(symbols.cross)} Failed to launch: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
    process.exitCode = 1;
    return undefined;
  }
}