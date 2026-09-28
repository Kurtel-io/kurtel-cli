# Kurtel CLI

**Team memory and the right context for coding agents.**

Kurtel remembers what your team teaches its coding agents and gives Claude Code and Codex exactly the context each task needs. When you correct the agent and say why, Kurtel keeps your words, shares them with the teammates who work on the same repository, and gives them back to every agent at the moment they matter. Alongside that knowledge, Kurtel maps your repository (routes, imports, calls) so the agent starts from the right files instead of searching.

## Quick start

Requires Node.js 18 or later.

```sh
npm install -g @kurtel/cli
kurtel login
kurtel install claude-code      # in each repository you work on
kurtel install codex            # and/or Codex
```

Then use your agent as usual.

Kurtel turns on only in a repository your organization declared on [kurtel.io](https://www.kurtel.io) and gave you access to. It recognizes the repository by the folder's `origin` remote (HTTPS or SSH) and checks your access at the start of a session. There it starts on its own; anywhere else it stays silent and writes nothing.

## Memory and context

**Memory.** Kurtel learns durable knowledge from your sessions: a convention, a constraint, a decision with its reason. When you correct the agent and explain why, your own words become knowledge. Knowledge is confirmed each time it serves without a correction and contested when a correction contradicts it. It is shared with the members who have access to the same repository, never across repositories or organizations, and each piece reaches the agent with its origin.

**Context.** Kurtel indexes routes, imports, exports and call relationships, keeps the index current as the code changes, and gives the agent what matters for the task: the knowledge that applies to the files involved, where a route is defined, which files depend on the one being edited. Coverage is bounded: an impact report is a strong hint, not proof that every dependency was found.

In each repository you can turn memory off and keep only the code context, or turn Kurtel off entirely:

```sh
kurtel memory off               # code context only
kurtel memory on
kurtel off                      # Kurtel entirely off in this repository
kurtel on
kurtel memory status
```

## Claude Code and Codex

**Claude Code.** Kurtel runs as hooks: the relevant knowledge and code context are added to each prompt, the rules for a file are shown before its first edit, and dependents are pointed out after it. Learning from sessions is automatic. The `/kurtel:` slash commands give the same controls as the CLI.

**Codex.** Kurtel runs as an MCP server for the repository, with guidance added to `AGENTS.md`: the agent asks for context (`get_context`), impact (`get_impact`) and past decisions (`explain_decision`, `search_history`) when it needs them.

```sh
kurtel install codex                     # graph and memory tools
kurtel install codex --graph-only        # graph tools only
kurtel install codex --capture           # also learn from Codex sessions
kurtel uninstall codex
```

With `--capture`, trust the Kurtel hooks in Codex `/hooks`, then start a new session. `kurtel mcp --root <repository>` serves a repository to any other MCP client, read-only by default.

## Commands

```sh
kurtel memory preview "update billing"   # what would be injected for this prompt
kurtel memory log                        # what was injected, prompt by prompt
kurtel memory sync                       # send and receive shared knowledge now
kurtel context "Inspect lib/stripe.ts" --json
kurtel impact src/billing.ts             # who depends on this file or function
kurtel knowledge status
kurtel knowledge why "gateway"           # sourced explanation of a decision
kurtel knowledge history "gateway"
kurtel knowledge export
kurtel sessions off                      # stop capturing this repository's sessions
kurtel watch status
kurtel whoami
kurtel doctor
kurtel uninstall claude-code
```

## What leaves your machine

- **Source code:** never. The graph sent to kurtel.io is a digest of paths, exports, routes and relationships.
- **Memory:** conversations are captured locally as a temporary buffer. Bounded excerpts are sent to kurtel.io, which uses a hosted language model to extract knowledge and recognize corrections; Kurtel does not store those requests. Captured text is erased from your machine once it has been learned from. Learned knowledge (short quotes with their files) is stored on kurtel.io for the members of your organization who have access to the repository. Conversations themselves are never shared.
- With `kurtel memory off`, only the graph digest is sent.
- Every request is checked against your access to the repository. When access is removed, Kurtel stops in that repository and erases the knowledge it stored there on your machine.
- Context given to an assistant is then subject to that assistant's own provider settings.

## Troubleshooting

- **Kurtel stays silent in a repository.** Run `kurtel access`: it says whether the repository is declared by your organization and whether you have access, and what to ask your admin if not.
- **"Declared in several of your organizations".** The same repository belongs to more than one of your organizations, each with its own memory. Pick one for this folder with `kurtel org use <slug>`.
- **Anything else.** `kurtel doctor` checks your installation.

## Enterprise deployment

Enterprise plans can run Kurtel entirely on their own infrastructure. `kurtel network private <engine-origin>` sends memory requests only to your own learning engine; `kurtel network offline` keeps everything on the machine (graph only). `kurtel backup create` and `kurtel backup restore` save and restore local knowledge.

## Development

```sh
npm ci
npm run build
npm test
npm run dev -- --help
```
