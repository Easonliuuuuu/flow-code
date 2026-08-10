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

The scaffolded file is heavily commented. See the [workflow reference](docs/workflow-reference.md) for everything it accepts — loop-backs, conditional routing, budgets, worktrees — and the [node type reference](docs/node-types.md) for each type's config fields and output. `flow-code node-types` prints the same reference in your terminal.

## CLI reference

| Command | Description |
| --- | --- |
| `flow-code init` | Scaffold `.flow-code/workflow.yaml` and configure provider/models |
| `flow-code init --preset openspec` | Scaffold the OpenSpec graph (`explore → propose → apply → archive`) |
| `flow-code init --preset spec-kit` | Scaffold after GitHub Spec Kit (`specify → plan → implement`) |
| `flow-code run` | Execute the workflow graph |
| `flow-code watch` | Follow a run started elsewhere — same graph, read-only |
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

`watch` attaches to whichever run is currently being written, and picks up a run started *after* it was opened, so it can be left open on a second monitor. Pass a run id (`flow-code watch <runId>`) to pin it to one run. It never writes: the keys that edit `workflow.yaml` are disabled, and the header reports whether the process driving the run is still alive.

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
| [Workflow reference](docs/workflow-reference.md) | Nodes, edges, loop-backs, conditional routing, budgets, worktrees |
| [Skills](docs/skills.md) | Attaching custom `SKILL.md` instructions to a node |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the pull request workflow.

## License

[MIT](LICENSE)
