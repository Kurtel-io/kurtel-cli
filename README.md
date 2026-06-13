# Kurtel CLI

**Launch self-improving coding agents in the cloud — with a persistent memory of your codebase.**

`kurtel` gives your coding agents two things they normally lack: a place to run
asynchronously (isolated cloud sandboxes) and a **memory** — a local, deterministic
map of your codebase plus the conventions your team has learned from its merged
PRs. Relevant context is injected into Claude Code exactly when a task needs it.

- **Codebase memory** — routes, import graph, call graph, and blast-radius
  analysis, extracted locally. Zero tokens, deterministic, works offline.
- **Cross-lingual** — prompt in any language; aligned word-vectors resolve it to
  the right code even when the words don't match the identifiers.
- **Darwinian patterns** — team conventions learned from merged PRs, each with a
  fitness score that rises or falls over time (cloud feature).
- **Cloud runs** — fan out agents across repos in isolated sandboxes (cloud feature).

---

## Install

```bash
npm install -g @kurtel/cli
```

Requires Node ≥ 18.

---

## Quick start

```bash
# 1. Wire Kurtel into Claude Code (slash commands + hooks). No account needed.
kurtel install claude-code

# 2. Index this repo — builds the local codebase memory.
kurtel onboard

# 3. Open Claude Code and work as usual.
#    Relevant context is now injected automatically on every prompt.
```

No account is required for the local codebase memory. Sign in only to unlock
shared **darwinian patterns**, the web dashboard, and **cloud runs**:

```bash
kurtel login
```

---

## Claude Code integration

`kurtel install claude-code` writes **slash commands** to
`.claude/commands/kurtel/` and wires **hooks** into `.claude/settings.json`.
Every CLI command is also available as a `/kurtel:*` slash command.

### Slash commands

Type `/kurtel:` in Claude Code to see them all.

| Slash command | Does |
|---|---|
| `/kurtel:onboard` | Index the codebase and activate memory (architecture snapshot) |
| `/kurtel:status` | Memory status for this repo (index freshness, patterns, sync) |
| `/kurtel:memory <on\|off\|sync\|patterns\|vectors>` | Toggle or inspect memory |
| `/kurtel:impact <file\|fn>` | Blast radius of a change (who breaks if I touch X) |
| `/kurtel:run <task>` | Launch a cloud agent on a task |
| `/kurtel:runs` | List your recent cloud runs |
| `/kurtel:agents` | List active cloud agents |
| `/kurtel:logs <id>` | Stream a run's logs |
| `/kurtel:run-status <id>` | Show a specific run's status |
| `/kurtel:stop <id>` | Stop an agent and tear down its sandbox |
| `/kurtel:whoami` | Show the signed-in account |
| `/kurtel:login` | Sign in to Kurtel |
| `/kurtel:logout` | Sign out |
| `/kurtel:config` | View or change local configuration |
| `/kurtel:init` | Initialize Kurtel in the current project |
| `/kurtel:doctor` | Check your environment |

### Hooks (automatic)

These run on their own — you never type them:

| Event | What Kurtel does |
|---|---|
| `SessionStart` | Background sync (patterns) + a one-line memory status |
| `UserPromptSubmit` | Injects the **capsule** — relevant routes, conventions, and zones for this task |
| `PostToolUse` (Edit/Write) | Flags duplicate routes, injects zone context, shows blast radius |
| `SessionEnd` | Flushes usage telemetry in the background |

Remove everything cleanly with `kurtel uninstall claude-code`.

---

## Command reference

### Memory (local — no account)

```bash
kurtel onboard [--local] [--json]      # index the repo; --local skips cloud upload
kurtel memory status                   # memory state for this repo
kurtel memory on | off                 # enable / disable injection for this repo
kurtel memory sync                     # pull patterns + flush telemetry
kurtel memory patterns                 # list learned team patterns
kurtel memory vectors status           # cross-lingual table status
kurtel memory vectors import <file>    # build the aligned word-vector table from a .vec
kurtel impact <file | file::fn | fn>   # reverse imports + call graph (blast radius)
```

### Cloud runs (account required)

```bash
kurtel run "<task>" [--repo <r>] [--branch <b>] [--engine <e>] [--model <m>]
kurtel runs                            # list recent runs
kurtel agents | ps                     # list active agents
kurtel logs <id> [--follow]            # stream a run's logs
kurtel status <id>                     # a run's status
kurtel stop <id>                       # stop an agent & tear down its sandbox
```

### Account & project

```bash
kurtel login | logout | whoami
kurtel config [list | get | set] [key] [value]
kurtel init                            # write project-level .kurtel/config.json
kurtel doctor                          # check your environment
kurtel install   claude-code           # wire slash commands + hooks
kurtel uninstall claude-code           # remove them
kurtel -v | --version
kurtel -h | --help
```

Run `kurtel` with no arguments for the interactive session.

---

## How the memory works

- **`kurtel onboard`** walks the repo with tree-sitter (TS/JS, Python, Java, Go,
  Rust, C#), extracting modules, exports, an import graph, a symbol-level call
  graph, an inventory of HTTP routes, and the high-coupling "god nodes". The
  digest is written to `.kurtel/index.json` and a readable audit to
  `.kurtel/REPORT.md`. It's fully deterministic — same commit, same index.
- On every prompt, the **capsule** resolves the intent to the right zones of the
  graph and injects a compact, budgeted block (~400 tokens) — only when relevant.
  Silence is the default.
- **Cross-lingual resolution** uses an aligned French/English word-vector table
  bundled with the package, so a prompt like *"ajoute un moyen d'encaisser les
  clients"* finds `billing/charge.ts` even though no words match.
- **Darwinian patterns** are pulled from the Kurtel cloud (when signed in) and
  injected the same way — conventions your team confirmed or contradicted through
  its PRs.

### Privacy

The codebase memory is local and deterministic. When you are not signed in, no
data leaves your machine — the background sync simply no-ops. Your source never
leaves the sandbox during a cloud run.

---

## File locations

```
<repo>/.kurtel/index.json        # codebase index (deterministic, shareable)
<repo>/.kurtel/REPORT.md         # architecture audit
~/.kurtel/config.json            # CLI config + session token
~/.kurtel/cache/<repo>/          # patterns, telemetry, module vectors (per repo)
~/.kurtel/vectors/               # user-imported word-vector table (optional override)
```

---

## Development

```bash
npm run dev      # run from source with tsx (no build step)
npm run build    # compile TypeScript to dist/
npm start        # run the compiled CLI
```

Built as an ESM TypeScript project targeting Node ≥ 18, with a single runtime
dependency (`commander`). The terminal UI is hand-rolled with ANSI escapes and
honors `NO_COLOR`.
