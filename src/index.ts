#!/usr/bin/env node
import { Command } from "commander";
import { knowledgeCommand } from "./commands/knowledge.js";
import { contextCommand, contextUsageCommand } from "./commands/context.js";
import { sessionsCommand } from "./commands/sessions.js";
import { getVersion } from "./lib/version.js";
import { c, symbols } from "./ui/colors.js";
import { startSession } from "./session/repl.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { configCommand } from "./commands/config.js";
import { initCommand, doctorCommand } from "./commands/project.js";
import { onboardCommand } from "./commands/onboard.js";
import { memoryCommand } from "./commands/memory.js";
import { installClaudeCodeCommand, uninstallClaudeCodeCommand } from "./integrations/claude-code/install.js";
import { hookCommand } from "./integrations/claude-code/hooks.js";
import { impactCommand } from "./commands/impact.js";
import { watchCommand } from "./commands/watch.js";
import { uninstallCommitHook } from "./integrations/git/hooks.js";

const program = new Command();

program.command("backup")
  .description("Back up knowledge and captured events, or restore to an empty knowledge directory")
  .argument("<action>", "create | restore")
  .argument("<file>")
  .option("--relocate", "Restore into the current repository's new canonical path")
  .action(async (action, file, options) => {
    const { backupKnowledge, restoreKnowledge } = await import("./storage/backup.js");
    const { repoRoot } = await import("./repository/git.js");
    if (!["create", "restore"].includes(action)) throw new Error("Use backup create | restore <file>");
    console.log(JSON.stringify(action === "create" ? backupKnowledge(repoRoot(), file) : restoreKnowledge(repoRoot(), file, options.relocate), null, 2));
  });


program.command("network")
  .description("Persistent network policy: status | offline | private <engine-origin...> | cloud")
  .argument("[mode]", "Policy mode", "status")
  .argument("[origins...]")
  .action(async (mode, origins) => {
    const { networkPolicy, saveNetworkPolicy, policyPath } = await import("./security/network.js");
    if (mode !== "status") saveNetworkPolicy({ version: 1, mode, engine_origins: origins });
    console.log(JSON.stringify({ path: policyPath(), ...networkPolicy() }, null, 2));
  });


program.command("codex-capture", { hidden: true }).requiredOption("--root <directory>").action(async options => {
  const { codexCaptureCommand } = await import("./integrations/codex/capture.js"); await codexCaptureCommand(options.root);
});

program.command("mcp")
  .description("Serve the fixed repository over MCP stdio (read-only by default)")
  .requiredOption("--root <directory>", "Repository to expose; tools cannot switch roots")
  .option("--graph-only", "Expose graph tools only, without memory or engine calls")
  .option("--allow-remember", "Allow sourced proposals; never automatic promotion")
  .action(async options => { const { serveMcp } = await import("./integrations/mcp/server.js"); await serveMcp(options); });

program.command("context")
  .description("Inspect bounded code/memory context without consuming session delivery state")
  .argument("<prompt>")
  .option("--mode <mode>", "action | investigation", "action")
  .option("--path <paths...>", "Explicit repository-relative task paths")
  .option("--budget <tokens>", "Local cl100k_base token budget", "600")
  .option("--json", "Include token counts, omissions and evaluation warnings")
  .action(contextCommand);

program.command("context-usage")
  .description("How often injected context was followed by a read or edit of the files it cites (local journal)")
  .option("--json", "Machine-readable report")
  .action(contextUsageCommand);

program
  .name("kurtel")
  .description("Codebase graph and team memory for your coding assistant.")
  .version(getVersion(), "-v, --version", "Print the CLI version")
  .helpOption("-h, --help", "Show help")
  .addHelpText(
    "afterAll",
    `\n${c.dim("Run")} ${c.indigo("kurtel")} ${c.dim(
      "with no arguments to open the interactive session."
    )}\n`
  );

program.action(async () => {
  if (program.args.length) {
    throw new Error(`unknown command '${program.args[0]}'. Run kurtel --help for graph and memory commands.`);
  }
  if (!process.stdin.isTTY) { program.help(); return; }
  await startSession();
});

program
  .command("login")
  .description("Sign in to Kurtel")
  .option("--team-endpoint <url>", "Authenticate to a hosted or company engine /v2/team endpoint")
  .option("--token-env <name>", "Environment variable holding your personal team token", "KURTEL_TEAM_TOKEN")
  .action(async options => loginCommand(options));

program.command("team")
  .description("Explicit reviewed memory sharing: connect | disconnect | prepare | publish | sync | history | erase")
  .argument("<action>")
  .argument("[value]", "Version ID, reviewed JSON file, or shared knowledge ID")
  .option("--team <id>", "Team granted by the server")
  .option("--repo <name>", "Exact repository granted by the server")
  .option("--since <cursor>", "Sync cursor (no shared payload is cached)", "0")
  .action(async (action, value, options) => {
    const { teamCommand } = await import("./commands/team.js"); await teamCommand(action, value, options);
  });

program
  .command("on")
  .description("Turn Kurtel back on in this repository (graph, and memory where included)")
  .action(async () => {
    const { switchCommand } = await import("./commands/switch.js"); switchCommand(true);
  });

program
  .command("off")
  .description("Turn Kurtel off in this repository: no graph, no memory (kurtel memory off keeps the graph)")
  .action(async () => {
    const { switchCommand } = await import("./commands/switch.js"); switchCommand(false);
  });

program
  .command("access")
  .description("Check whether this repository is declared by your organization and accessible to you")
  .option("--quiet", "Keep the answer without printing it")
  .option("--json", "Machine-readable output")
  .action(async options => {
    const { accessCommand } = await import("./commands/access.js"); await accessCommand(options);
  });

program
  .command("org")
  .description("Organization of this repository: status | use <slug> (when it is declared in several of yours)")
  .argument("[action]", "status | use")
  .argument("[slug]", "Organization slug")
  .option("--json", "Machine-readable output")
  .action(async (action, slug, options) => {
    const { orgCommand } = await import("./commands/access.js"); await orgCommand(action, slug, options);
  });

program
  .command("logout")
  .description("Sign out")
  .action(async () => logoutCommand());

program
  .command("whoami")
  .description("Show the signed-in account")
  .action(() => whoamiCommand());

program
  .command("config")
  .description("View or change local configuration")
  .argument("[action]", "list | get | set", "list")
  .argument("[key]", "Config key")
  .argument("[value]", "Value (for set)")
  .action((action, key, value) => configCommand(action, key, value));

program
  .command("init")
  .description("Initialize Kurtel in the current project")
  .action(async () => initCommand());

program
  .command("doctor")
  .description("Check your environment")
  .action(() => doctorCommand());

program
  .command("install")
  .description("Install a Kurtel integration (claude-code | codex)")
  .argument("<target>", "Integration target: claude-code | codex")
  .option("--force", "Install even if this folder is not a git repository", false)
  .option("--graph-only", "Codex: expose graph tools only")
  .option("--allow-remember", "Codex: allow proposed memory writes via MCP")
  .option("--capture", "Codex: install automatic conversation capture hooks")
  .action(async (target: string, opts) => {
    if (target === "claude-code") {
      if (opts.graphOnly || opts.allowRemember || opts.capture) throw new Error("These options configure Codex MCP only. For Claude MCP, register kurtel mcp with the desired flags separately.");
      return installClaudeCodeCommand(opts);
    }
    if (target === "codex") { const { installCodexCommand } = await import("./integrations/codex/install.js"); return installCodexCommand(opts); }
    console.log(`${c.red(symbols.cross)} Unknown target ${c.white(target)}. Try ${c.indigo("claude-code")}.`);
    process.exitCode = 1;
  });

program
  .command("uninstall")
  .description("Remove a Kurtel integration (claude-code | codex)")
  .argument("<target>", "Integration target: claude-code | codex")
  .action(async (target: string) => {
    if (target === "claude-code") return uninstallClaudeCodeCommand();
    if (target === "codex") { const { uninstallCodexCommand } = await import("./integrations/codex/install.js"); return uninstallCodexCommand(); }
    console.log(`${c.red(symbols.cross)} Unknown target ${c.white(target)}.`);
    process.exitCode = 1;
  });

program
  .command("onboard")
  .alias("setup")
  .description("Index this codebase and activate Kurtel memory")
  .option("--json", "Machine-readable output (used by /kurtel:onboard)", false)
  .option("--local", "Skip cloud upload — index stays on disk", false)
  .action(async (opts) => onboardCommand(opts));

program
  .command("impact")
  .description("Blast radius of changing a file or function (reverse imports + call graph)")
  .argument("[target...]", "file path, file::function, or unique function name")
  .option("--json", "Machine-readable output", false)
  .option("--depth <n>", "Max BFS depth (default 4)")
  .action(async (parts: string[], opts) => impactCommand((parts ?? []).join(" "), opts));

program
  .command("memory")
  .description("Inspect or toggle Kurtel memory (status | on | off | sync | share | preview | log | vectors)")
  .argument("[action]", "status | on | off | sync | share | preview | log | vectors", "status")
  .argument("[args...]", "extra args (e.g. `preview \"<prompt>\"`, `log clear`, `share on|off|status|now`, `vectors import <file.vec>`)")
  .option("--json", "Machine-readable output", false)
  .option("--quiet", "No spinner/log output (used by background sync)", false)
  .option("--global", "Apply on/off to every repo on this machine (kill switch)", false)
  .option("--max <n>", "Max words to import (vectors import)")
  .option("--out <dir>", "Output dir for the built table (vectors import; default ~/.kurtel/vectors)")
  .action(async (action, args, opts) => memoryCommand(action, opts, args));

program
  .command("sessions")
  .description("Session capture, learning engine and sourced working memory")
  .argument("[action]", "on | off | status | list | show | ingest | engine | learning-off | learn | resume | correction", "status")
  .argument("[session]", "Session ID or engine endpoint URL")
  .argument("[message]", "correction: captured message event ID (started by the prompt hook)")
  .action((action: string, session?: string, message?: string) => sessionsCommand(action, session, message));

program
  .command("knowledge")
  .description("Versioned knowledge, history and sourced explanations")
  .argument("[action]", "status | export | import | history | why | counterexamples | sources | github | trace", "status")
  .argument("[target]", "Snapshot file, exact ID or quoted search phrase")
  .option("--json", "Machine-readable query result")
  .option("--at <timestamp>", "Query knowledge recorded by this ISO timestamp")
  .option("--depth <n>", "Maximum explanation depth (1-20; default 6)")
  .action((action: string, target: string | undefined, opts) => knowledgeCommand(action, target, opts));

program
  .command("watch")
  .description("Continuously reindex this repo as files change (auto-starts on onboard)")
  .argument("[action]", "start | stop | status", "start")
  .option("--daemon", "Run silently in the background (used by auto-start)", false)
  .action(async (action: string, opts) => watchCommand(action, opts));

// Called by the post-commit hook of earlier versions: removes it.
program
  .command("learn-commit", { hidden: true })
  .action(() => { try { uninstallCommitHook(process.cwd()); } catch { /* Best effort. */ } });

program
  .command("hook", { hidden: true })
  .argument("<event>", "session-start | user-prompt-submit | pre-tool-use | post-tool-use | post-tool-use-failure | stop | session-end")
  .action(async (event: string) => hookCommand(event));

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(
      `${c.red(symbols.cross)} ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

main();
