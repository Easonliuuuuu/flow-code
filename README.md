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
- **Methodology presets** — `flow-code init --preset openspec` scaffolds an explore → propose → apply → archive graph wired to the OpenSpec skills; `--preset spec-kit` scaffolds a specify → plan → implement graph after GitHub Spec Kit; `--preset planned` scaffolds a spine and negotiates the rest of the graph with you at run time instead of declaring it up front. All three are ordinary node graphs, so they're as editable as anything else.

<p align="center">
  <img src="https://raw.githubusercontent.com/Easonliuuuuu/flow-code/main/docs/demo/flow-code.gif" width="900" alt="A flow-code run: eight nodes laid out as a graph, each card showing its status, model and token spend as the run moves through them, with a failing Test node routing back to Implement.">
</p>

```
  Discuss ─→ Spec ─→ Gate ─→ Implement ─→ Test ─→ Validate ─→ Review ─→ Gate ─→ Git-ops
     ↑                 │         ↑         │         │          │         │
     └─────────────────┘         └─────────┴─────────┴──────────┘         ↓
                                 ↑                                      Revise
                                 └───────────────────────────────────────┘

  a rejected spec loops back to Discuss
  a failing verdict loops back to Implement
  a rejected diff opens Revise, and what you settle there goes back to Implement
```

| Node | What it does |
| --- | --- |
| **Discuss** | The only interactive step — settles what is being built before anything runs headless. |
| **Spec** | Turns that discussion into acceptance criteria, written to `.flow-code/specs/<runId>.md`. |
| **Gate** (first) | Pauses for an explicit yes or no on the spec before any code is written; a rejection reopens Discuss with your reason. |
| **Implement** | Writes the code and the tests covering it. |
| **Test** | Runs your test commands, working them out from the repo the first time and asking you to confirm. The verdict is an exit code, never a model's opinion. |
| **Validate** | Checks the result against the spec's acceptance criteria, one by one. |
| **Review** | Reviews the pending diff. |
| **Gate** (second) | Pauses for an explicit yes or no before anything touches git; a rejection opens Revise. |
| **Revise** | A second conversation, reached only when you turn a diff down — a gate records your decision but not your reasoning, so this is what carries the *why* back to Implement. |
| **Git-ops** | Commits, and pushes if you configured a remote. |

Every node is optional and rewireable — the graph above is just what `flow-code init` scaffolds.

## Why a graph, not a chat log

This follows Anthropic's own split between *workflows* — LLMs and tools orchestrated through predefined, inspectable code paths — and *agents*, where an LLM directs its own process. flow-code commits to the first: a graph you can read before it runs, not a plan improvised as it goes. See [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents).

The `spec` node and the `openspec`/`spec-kit` presets apply the same commitment to the code itself: a written spec precedes implementation, outlives it, and is what changes get checked against — [spec-driven development](https://github.com/github/spec-kit), not a chat prompt discarded once the code exists.

`--preset planned` is the one deliberate exception, worth naming rather than leaving implicit: its graph isn't fixed at load, it's negotiated with you by a `plan` node before anything runs headless. Not a graph read in advance, but one agreed to before it runs — and nothing reaches git without approval either way. See [planning the graph](docs/workflow-reference.md#planning-the-graph).

## Installation

Requires Node.js 20 or newer.

```bash
npm install -g @easonliuuuuu/flow-code
```

The package is scoped; the command it installs is plain `flow-code`.

## Quickstart

See it run first, no setup required:

```bash
npx @easonliuuuuu/flow-code try
```

Seeds a throwaway repo with a failing test and runs the real default graph against it — every agent session is scripted (no live provider, no tokens spent, no credentials needed), but the engine, the loop-back, and both approval gates are the real ones. Pauses for your approval twice, same as a live run, and finishes by printing where the repo landed so you can look around.

Then, in a repository of your own:

```bash
flow-code init   # scaffold the workflow, pick a provider and model
flow-code run    # execute the graph
```

`init` walks you through provider and credential setup. Test commands are settled later, during the run itself: the first time the Test node executes it works out how your project runs its tests — package scripts and Makefile targets first, then a read-only agent pass — and shows you what it found to confirm. Nothing is run before you confirm it, and the answer is saved to `.flow-code/workflow.yaml`, so you are asked once per project rather than once per run.

To run from source instead:

```bash
npm install && npm run build
node dist/cli.js init
node dist/cli.js run
```

## Providers and credentials

`flow-code init` configures a provider interactively. It looks for credentials you already have first — every row of the table below is checked, and the picker labels each provider with what it found and starts on the first one that already works. If you are logged into `claude` or `codex`, or already export an API key, there is nothing to paste. To skip the wizard entirely (headless, CI), set any standard API key:

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
| `flow-code init --preset planned` | Scaffold a spine (`plan → gate → git-ops`) that negotiates the rest at run time |
| `flow-code run` | Execute the workflow graph |
| `flow-code run --graph <name>` | Execute a named graph, for a file declaring more than one |
| `flow-code watch` | Follow a run started elsewhere — same graph, read-only |
| `flow-code status` | Summarize the current run in a row or two — for a status bar, not a window |
| `flow-code node <sub>` | Report progress through the graph from an agent flow-code is not running |
| `flow-code connect` | Install the reporting surface into this project's agent configuration |
| `flow-code mcp` | Serve the reporting tools over MCP (launched by a host agent, not by hand) |
| `flow-code hook <event>` | Apply the current step's capability set to a host session's tool call |
| `flow-code reconcile` | Check a run's claims against the repository — read-only and advisory |
| `flow-code validate` | Check `.flow-code/workflow.yaml` without running it |
| `flow-code node-types` | List every node type and its configuration |
| `flow-code skills` | List skills attachable from `.claude/skills` or plugins |
| `flow-code doctor` | Diagnose environment, tools, and provider credentials |
| `flow-code help` | Show the full command reference |

## Watching a run

A second window can follow any run, read-only, from anywhere that can read the repo — `flow-code watch`. When there's no window to spare, `flow-code status` compresses the same run into one or two rows, sized to fit a status bar. See [Watching and status](docs/observability.md) for both, including driver-liveness detection (`live`/`gone`/`unknown`) and `status --json`/`--script`.

## Driving the graph from your own agent

`flow-code run` executing the graph is one option, not a requirement. `flow-code connect` installs the tools and instructions for you to walk the graph yourself from `claude`, `codex`, or any agent CLI, reporting each transition as you go; there's also a Claude Code plugin that needs no per-project install. See [Driving the graph from your own agent](docs/agent-integration.md) for the enforcement tiers a self-driven run can and can't claim, and `flow-code reconcile`, which checks a run's claims against the repository itself.

## Keyboard controls

Press `?` in a run for the full map, including the panel and mouse gestures. The keys worth knowing before you start:

| Key | Action |
| --- | --- |
| `?` | The whole key map, in a panel |
| `tab` / `shift+tab` | Focus the next / previous node |
| `enter` | Open the focused node's details — `esc` closes it |
| `e` | Edit the focused node's settings |
| `m` | Change the focused node's model |
| `s` | Attach or detach skills |
| `←→↑↓` | Pan the canvas (add `shift` while a panel has the keyboard) |
| `z` | Toggle compact cards — the canvas does this itself once the graph outgrows the terminal |
| `o` | Overview: one row per node, for a graph too big to read as cards |
| `c` | Centre the canvas on the focused node, or leave it where it is |
| `w` | Wrap a graph wider than the terminal into bands, or lay it flat |
| `q` | Quit |

The mouse is an enhancement layer, never the only way to do something: click a card to focus it, drag it to move it, click a model or skill badge to open that picker, and drag a panel by its `⠿` handle or resize it from the `⇲` corner (`ctrl+p` docks it again). The wheel pans, `shift+wheel` pans sideways, and `ctrl+wheel` zooms.

Nodes can be edited mid-run: focus one and press `e` for its settings, `m` for its model, or `s` to attach skills. Changes are written back to `.flow-code/workflow.yaml` and picked up by any node that has not started yet.

## Documentation

| Guide | Covers |
| --- | --- |
| [Node type reference](docs/node-types.md) | Every node type: capabilities, config fields, recorded output |
| [Workflow reference](docs/workflow-reference.md) | Nodes, edges, loop-backs, conditional routing, budgets, worktrees, named graphs |
| [Skills](docs/skills.md) | Attaching custom `SKILL.md` instructions to a node |
| [Watching and status](docs/observability.md) | Following a run from another window or a status line |
| [Driving the graph from your own agent](docs/agent-integration.md) | `connect`, enforcement tiers, and `reconcile` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the pull request workflow.

## License

[MIT](LICENSE)
