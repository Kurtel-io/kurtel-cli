# Kurtel CLI

Launch self-improving coding agents in the cloud — from your terminal, your
editor, or CI. `kurtel` drops you into an interactive session (like a coding
copilot REPL) and also exposes scriptable subcommands.

> **Preview build.** The commands run end-to-end locally with realistic output,
> but they are **not yet connected to the Kurtel cloud**. They're stubs that
> define the experience.

## Install

From source (during preview):

```bash
git clone <repo> kurtel-cli && cd kurtel-cli
npm install        # builds automatically via the prepare script
npm link           # makes `kurtel` available everywhere (incl. the VSCode terminal)
```

Then, in any project:

```bash
kurtel
```

To remove the global link later: `npm unlink -g kurtel`.

> Once published, install will be a one-liner: `npm install -g kurtel`.

## Usage

```text
kurtel                       Open the interactive session
kurtel run "<task>"          Launch a cloud agent on a task
kurtel agents | ps           List active agents
kurtel logs <id>             Stream an agent's logs
kurtel status <id>           Show an agent's status
kurtel stop <id>             Stop an agent & tear down its sandbox
kurtel login | logout        Manage your session
kurtel config [list|get|set] View or change local config
kurtel init                  Initialize Kurtel in the current project
kurtel doctor                Check your environment
kurtel -v | --version        Print version
kurtel -h | --help           Show help
```

### Interactive session

Run `kurtel` with no arguments. Type a task to launch an agent, or use slash
commands:

```text
/help            Show commands
/run <task>      Launch a cloud agent
/agents          List active agents
/login           Sign in
/config          Show configuration
/clear           Clear the screen
/exit            Quit
```

Exit with `/exit` or `Ctrl+D`.

## Development

```bash
npm run dev      # run from source with tsx (no build step)
npm run build    # compile TypeScript to dist/
npm start        # run the compiled CLI
```

## Project layout

```
src/
  index.ts            # entry — commander wiring + shebang
  session/repl.ts     # interactive session
  commands/           # one file per command group (stubs)
    run.ts  auth.ts  agents.ts  runtime.ts  config.ts  project.ts
  ui/                 # colors, box, banner, spinner (zero-dep)
  lib/                # version, config (~/.kurtel/config.json), sample data
```

## Notes

- Built as an ESM TypeScript project targeting Node ≥ 18.
- Only one runtime dependency (`commander`); the terminal UI is hand-rolled with
  ANSI escapes and honors `NO_COLOR`.
- Local config lives at `~/.kurtel/config.json`; `kurtel init` writes a
  project-level `.kurtel/config.json`.
