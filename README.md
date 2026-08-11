<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/flow-code-dark.svg">
    <img alt="flow-code" src="docs/logo/flow-code-light.svg" height="70">
  </picture>
  <br>
  <a href="https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml"><img src="https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node"></a>
</p>

A terminal-native node-graph interface for running and observing agentic coding workflows.

Instead of scrolling a chat log, a coding task runs as a graph you can watch: each step is a live card showing its status, token spend, model, and streaming output. Steps that fail route back upstream and try again, and nothing reaches git without your explicit approval.

- **Every node is customizable** — provider, model, config, and attached skills can all be set per node, and edited mid-run with `e` (settings), `m` (model), or `s` (skills), no restart required.
- **Methodology presets** — `flow-code init --preset openspec` scaffolds an explore → propose → apply → archive graph wired to the OpenSpec skills; `--preset spec-kit` scaffolds a specify → plan → implement graph after GitHub Spec Kit. Both are ordinary node graphs, so they're as editable as anything else.

<p align="center">
  <img src="https://raw.githubusercontent.com/Easonliuuuuu/flow-code/main/docs/demo/flow-code.gif" width="900" alt="A flow-code run: eight nodes laid out as a graph, each card showing its status, model and token spend as the run moves through them, with a failing Test node routing back to Implement.">
</p>

```
  Discuss ─→ Spec ─→ Implement ─→ Test ─→ Validate ─→ Review ─→ Gate ─→ Git-ops
                         ↑          │         │          │
                         └──────────┴─────────┴──────────┘
                             loop back on a failing verdict
```

| Node | What it does |
| --- | --- |
| **Discuss** | The only interactive step — settles what is being built before anything runs headless. |
| **Spec** | Turns that discussion into acceptance criteria, written to `.flow-code/specs/<runId>.md`. |
| **Implement** | Writes the code and the tests covering it. |
| **Test** | Runs your test commands. The verdict is an exit code, never a model's opinion. |
| **Validate** | Checks the result against the spec's acceptance criteria, one by one. |
| **Review** | Reviews the pending diff. |
| **Gate** | Pauses for an explicit yes or no before anything touches git. |
| **Git-ops** | Commits, and pushes if you configured a remote. |

Every node is optional and rewireable — the graph above is just what `flow-code init` scaffolds.

## Installation

Requires Node.js 20 or newer.

```bash
npm install -g @easonliuuuuu/flow-code
```

The package is scoped; the command it installs is plain `flow-code`.

## Quickstart

Run these in any git repository:

```bash
flow-code init   # scaffold the workflow, pick a provider and model
flow-code run    # execute the graph
```

`init` walks you through provider and credential setup. Test commands are settled later, during the run itself: the Test node asks what it should run the first time it executes — after Discuss has established what is being built — and saves the answer to `.flow-code/workflow.yaml`.

To run from source instead:

```bash
npm install && npm run build
node dist/cli.js init
node dist/cli.js run
```

## Providers and credentials

`flow-code init` configures a provider interactively. To skip the wizard (headless, CI), set any standard API key:

| Provider | Environment variable | Fallback |
| --- | --- | --- |
| Claude | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | `claude` CLI login |
| Codex | `OPENAI_API_KEY` or `CODEX_API_KEY` | `codex` CLI login |
| OpenAI | `OPENAI_API_KEY` | — |
| OpenRouter | `OPENROUTER_API_KEY` | — |

Claude and Codex fall back to their own CLI login when no key is set, drawing on that subscription's usage rather than metered API billing. OpenAI and OpenRouter always bill against the key provided.

Each node can override the provider and model, so an expensive step and a cheap one need not share either — set it in `workflow.yaml`, or change it live with `m` while a run is going.

## Configuration

Workflows live in `.flow-code/workflow.yaml`, checked into your repo. A minimal graph:

```yaml
settings:
  concurrency: 2
  # Whether a node's agent may delegate to subagents (default: true). A
  # subagent runs under its parent node's capability set and working
  # directory, and counts against `concurrency` like any other session.
  subagents: true
  budget:
    tokensPerRun: 2000000
    minutesPerRun: 60

nodes:
  - id: discuss
    type: discuss
    config:
      topic: What should this change accomplish?
  - id: spec
    type: spec
  - id: implement
    type: implement
  - id: test
    type: test
    config:
      commands: ["npm test"]
  - id: validate
    type: validate
  - id: review
    type: review
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops

edges:
  - { from: discuss, to: spec }
  - { from: spec, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
  - { from: spec, to: validate }
  - { from: validate, to: review }
  - { from: review, to: gate }
  - { from: gate, to: git-ops }

  # On failure, return to implement and re-run everything in between.
  - { from: test, to: implement, loopback: { maxAttempts: 3 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
```

The scaffolded file is heavily commented. See the [workflow reference](docs/workflow-reference.md) for everything it accepts — loop-backs, conditional routing, budgets, worktrees, named graphs — and the [node type reference](docs/node-types.md) for each type's config fields and output. `flow-code node-types` prints the same reference in your terminal.

A file can also declare more than one named graph — a quick shape and a heavily
verified one, say — instead of one flat `nodes`/`edges` list. `flow-code run` asks
which to execute when more than one is declared and none is given on the command
line; `--graph <name>` skips the question. See
[Named graphs](docs/workflow-reference.md#named-graphs) for the file shape.

## CLI reference

| Command | Description |
| --- | --- |
| `flow-code init` | Scaffold `.flow-code/workflow.yaml` and configure provider/models |
| `flow-code init --preset openspec` | Scaffold the OpenSpec graph (`explore → propose → apply → archive`) |
| `flow-code init --preset spec-kit` | Scaffold after GitHub Spec Kit (`specify → plan → implement`) |
| `flow-code run` | Execute the workflow graph |
| `flow-code run --graph <name>` | Execute a named graph, for a file declaring more than one |
| `flow-code watch` | Follow a run started elsewhere — same graph, read-only |
| `flow-code status` | Summarize the current run in a row or two — for a status bar, not a window |
| `flow-code node <sub>` | Report progress through the graph from an agent flow-code is not running |
| `flow-code connect` | Install the reporting surface into this project's agent configuration |
| `flow-code mcp` | Serve the reporting tools over MCP (launched by a host agent, not by hand) |
| `flow-code validate` | Check `.flow-code/workflow.yaml` without running it |
| `flow-code node-types` | List every node type and its configuration |
| `flow-code skills` | List skills attachable from `.claude/skills` or plugins |
| `flow-code doctor` | Diagnose environment, tools, and provider credentials |
| `flow-code help` | Show the full command reference |

## Watching a run from another window

The engine writes complete run state to `.flow-code/runs/<runId>.json` after every change, so a run can be followed from anywhere that can read the repo:

```bash
flow-code run      # window 1 — drives the workflow
flow-code watch    # window 2 — same graph, read-only
```

`watch` attaches to whichever run is currently being written, and picks up a run started *after* it was opened, so it can be left open on a second monitor. Pass a run id (`flow-code watch <runId>`) to pin it to one run. It never writes: the keys that edit `workflow.yaml` are disabled, and the header reports whether the process driving the run is still alive. If two runs are live at once, `watch` names them and asks which — it will not pick one and appear to flip between them.

A run document records which process on which machine owns it, and only that process may write it: a second writer is refused rather than allowed to interleave. That makes the driver's state one of three things, and every reader — `watch`, `runs`, `status`, `doctor` — reports them apart:

| | What it means |
| --- | --- |
| **live** | The owning process is running on this machine. |
| **gone** | The owning process was on this machine and has exited — a crash, or a `kill -9` that skipped the shutdown path. Distinct from a run you interrupted with ctrl+c, which records that it ended and stays resumable. |
| **unknown** | This machine cannot answer: the run was driven from another machine over a shared checkout, or its document predates ownership being recorded. |

`unknown` is deliberately never rounded to either neighbour. It is why `flow-code doctor` leaves worktrees belonging to an unanswerable run alone rather than reclaiming them — "I can't tell" must not authorize deleting someone else's working tree.

## Keeping a run in view without a window

When there is no window to spare — you are in an agent CLI, an editor terminal, or a tmux pane doing something else — `flow-code status` compresses the same run into a row or two:

```
●discuss ●spec ●implement ●test ●validate ●review ◆gate ○git-ops  ◆ gate needs your approval  6/8 · 2.1M tok · 12% budget
```

It answers the three questions a graph answers — where the run is, what it has cost, what it needs from you — and nothing else. It shows sequence and status, not shape: no edges, no loop-back arcs, no layout. It is a pointer to the canvas, not a replacement for it.

```bash
flow-code status                  # a row or two, sized to your terminal
flow-code status --line           # exactly one row, for embedding in a status bar
flow-code status --json           # the same summary as data, plus an attention token
flow-code status --script         # a ready-made status-bar script, if you have none
```

`--line` emits one row and nothing else, so it can be pasted into a status bar you already have — in Claude Code, call it from your existing `statusLine` script rather than replacing that script, since a custom status line replaces some of the built-in footer hints. `--script` prints a complete one for a host with none; register it yourself (`status` never edits your host's configuration — `flow-code connect` is the one command that does, and it names every file it touches).

The output narrows as the width does: labelled nodes, then status glyphs, then whichever node is blocking the run and why — that last part is the thing it never drops. It works against any run in the repo, whoever started it, and it reads the run file without writing, locking, or slowing the process driving it. A run whose driver died reads as *driver gone* rather than as work in progress.

`--json` exists for scripting a notification: the payload carries an `attention` token that stays the same while the same node is blocked and changes when a different one is, so a hook can announce a waiting gate once instead of on every check. flow-code keeps no record of what it has announced — pass the last token back with `--since`.

## Driving the graph from your own agent

Everything above assumes `flow-code run` is executing the graph. It does not have to be. You can stay in the agent CLI you already use — `claude`, `codex`, whatever it is — walk the graph yourself, and have the run fill in beside you:

```bash
flow-code connect   # once per project: installs the tools and the instructions
flow-code watch     # second window — the graph fills in as your session reports
```

`connect` writes three things and names each one: an MCP server entry in `.mcp.json`, a skill at `.claude/skills/flow-code-workflow/SKILL.md`, and a delimited section in your `CLAUDE.md`/`AGENTS.md` — only inside its own delimiters, leaving the rest of the file byte-identical. Run it again after changing `workflow.yaml`; `flow-code connect --check` reports what is installed and whether it still matches.

For Claude Code specifically there is a plugin, which needs no per-project step at all — it reads the graph through a tool rather than installing a copy of it:

```
/plugin marketplace add Easonliuuuuu/flow-code
/plugin install flow-code
```

Either way your agent reports each transition (`flow-code node start <id>`, `… done <id> --output '{…}'`, `… fail <id> <reason>`), and every one is checked against the graph before it is recorded. A step cannot start before the steps above it are done, cannot complete without having started, and cannot complete with output that does not match its node type's shape. A rejected report changes nothing and says why.

### What a reported run is, and is not

flow-code validates the *order* of what an outside agent reports. It does not execute that agent, so it cannot enforce anything about what the agent actually did. Runs record which of three tiers they ran under, and every surface that displays a run says which:

| Tier | What is in force |
| --- | --- |
| **engine** | `flow-code run`: capability enforcement, process guards, per-node models, token accounting, loop-back routing. |
| **host session** | A session flow-code did not start, with its enforcement layer active: tool policy and git interception, and nothing that depends on having spawned the process. *Not in this build.* |
| **reported** | Self-reported. Transitions are checked against the graph; the work behind them is not. |

A reported run is labelled in the viewer on a line of its own, shows spend as `n/a` rather than as zero, and carries no activity log or denial counts — a run should not be able to display guarantees it never had. **A green graph from a reported run is a record of what your agent said it did, not evidence that anything was checked.**

Loop-backs are the one place a reported run is structurally different rather than merely less enforced: the engine *routes* a failure back to its target, and nothing routes it here. The generated instructions say so explicitly, and tell the agent to walk the return path itself.

## Keyboard controls

| Key | Action |
| --- | --- |
| `tab` | Focus the next node |
| `enter` | Open the focused node's details |
| `e` | Edit the focused node's settings |
| `m` | Change the focused node's model |
| `s` | Attach or detach skills |
| `←→↑↓` | Pan the canvas (add `shift` while a panel has the keyboard) |
| `z` | Toggle compact cards — the canvas does this itself once the graph outgrows the terminal |

Nodes can be edited mid-run: focus one and press `e` for its settings, `m` for its model, or `s` to attach skills. Changes are written back to `.flow-code/workflow.yaml` and picked up by any node that has not started yet.

## Documentation

| Guide | Covers |
| --- | --- |
| [Node type reference](docs/node-types.md) | Every node type: capabilities, config fields, recorded output |
| [Workflow reference](docs/workflow-reference.md) | Nodes, edges, loop-backs, conditional routing, budgets, worktrees, named graphs |
| [Skills](docs/skills.md) | Attaching custom `SKILL.md` instructions to a node |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the pull request workflow.

## License

[MIT](LICENSE)
