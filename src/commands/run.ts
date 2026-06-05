import { c, symbols } from "../ui/colors.js";
import { createRun, AuthError } from "../lib/api.js";
import { isEngineName } from "../lib/engines.js";

export interface RunOptions {
  repo?: string;
  branch?: string;
  engine?: string;
  model?: string;
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

  try {
    const run = await createRun({
      task,
      repo: opts.repo,
      branch: opts.branch,
      engine: opts.engine,
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