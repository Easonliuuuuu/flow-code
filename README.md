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

**A terminal-native node-graph interface for running and observing agentic coding workflows.**

Instead of scrolling a chat log, a coding task runs as a graph you can watch:
each step is a live card showing its status, token spend, model, and streaming
output. Steps that fail route back upstream and try again, and nothing reaches
git without your explicit approval.

<p align="center">
  <img src="https://raw.githubusercontent.com/Easonliuuuuu/flow-code/main/docs/demo/flow-code.gif" width="900" alt="Two terminal panes side by side. On the left a Claude Code session works through a task; on the right the same work draws as a five-node graph, each card taking its status from what the session reports, until the approval gate's prompt appears in the session and the gate card waits for it.">
</p>

The session on the left is one flow-code did not start. `flow-code connect`
installs the reporting surface into the agent you already use, and the graph
fills in beside it — no second agent, no extra tokens. Run the graph with
`flow-code run` instead and the same picture comes with enforcement behind it.

- **The verdict is an exit code, never an opinion.** The Test node runs your
  commands; a failure routes back to Implement and tries again, up to a bound
  you set.
- **Two approval gates, and they are structural.** One before any code is
  written, one before anything touches git. A graph where a git-writing node is
  reachable without passing a gate is rejected at load time.
- **Hard ceilings.** Tokens per node, tokens per run, minutes per run. A budget
  stop is final — it never retries past the limit that stopped it.

Every node is customizable: provider, model, config and attached skills are set
per node and editable mid-run with `e`, `m` or `s`, no restart.

## Watch the session on the left

For Claude Code specifically, there's a plugin — no per-project setup, no
`flow-code connect` step:

```
/plugin marketplace add Easonliuuuuu/flow-code
/plugin install flow-code
```

It reads your project's graph through a tool rather than installing a copy of
it. Then, in a second window:

```bash
flow-code watch
```

Work normally; the graph fills in as your session reports each step. For any
other agent CLI (`claude` without the plugin, `codex`, your own), `flow-code
connect` installs the same reporting surface into that project instead:

```bash
flow-code connect   # once per project: installs the tools and the instructions
flow-code watch     # second window — the graph fills in as your session reports
```

Both paths report the same way and cost nothing extra — no second agent, no
extra tokens. What you get less of is enforcement, and the docs say exactly how
much less: [Driving the graph from your own agent](docs/agent-integration.md).

## Try it

No repository, configuration, or credential needed:

```bash
npx @easonliuuuuu/flow-code try
```

Seeds a throwaway repo with a failing test and runs the real default graph
against it. Every agent session is scripted — no provider is contacted and no
tokens are spent — but the engine, the loop-back, and both approval gates are
the real ones, and it pauses for your approval twice exactly as a live run does.

## Install

Requires Node.js 20 or newer.

```bash
npm install -g @easonliuuuuu/flow-code
```

The package is scoped; the command it installs is plain `flow-code`. Then, in a
repository of your own:

```bash
flow-code init   # scaffold the workflow, pick a provider and model
flow-code run    # execute the graph
```

`init` looks for credentials you already have before asking for any — if you are
logged into `claude` or `codex`, there is nothing to paste. Test commands are
settled during the first run, not up front: the Test node works out how your
project runs its tests, shows you what it found, and saves your answer. Nothing
runs before you confirm it. See [Providers and credentials](docs/providers.md).

## What it costs

A small change on the default graph — eight nodes, six agent sessions, measured
end to end — comes to roughly:

| Claude Opus 5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| --- | --- | --- |
| ~$4.00 | ~$2.40 | ~$0.80 |

**Or nothing at all**, if you are signed in to the `claude` or `codex` CLI:
flow-code uses that login, so the run draws on that subscription rather than
metered billing.

You are trading tokens for structure — a spec that outlives the prompt, a
verdict that can't be argued with, a bounded retry, and two points where you say
yes or no. That is worth it for a change big enough to lose track of, and not
worth it for a typo. `flow-code init --preset frugal` scaffolds the same shape
with the expensive parts removed. Full measurement and five ways to spend less:
[What a run costs](docs/cost.md).

## Platform support

| Platform | State |
| --- | --- |
| Linux | Tested in CI on every push |
| macOS | Tested in CI on every push |
| WSL | Developed on daily |
| Windows (native) | **Not supported** — the Test node shells out via `sh -c` |

## CLI reference

<!-- BEGIN GENERATED: cli-commands -->
| Command | What it does |
| --- | --- |
| `flow-code try` | Run the real default graph against a seeded temporary repository |
| `flow-code init [--preset <name>]` | Scaffold .flow-code/workflow.yaml and configure the project |
| `flow-code run [--allow-dirty] [--graph <name>]` | Execute the workflow graph |
| `flow-code run --resume, -r [runId]` | Resume a run interrupted by ctrl+c or SIGTERM |
| `flow-code runs` | List past runs in this repo — id, when, status, node tally |
| `flow-code watch [runId]` | Follow a run started elsewhere — same graph, read-only |
| `flow-code status [--line] [--json] [--script] [--width N] [--dir <path>]` | Summarize the current run in one or two rows |
| `flow-code node <sub> …` | Report graph progress from an agent flow-code is not running |
| `flow-code connect [--check] [--status-line]` | Install the reporting surface into this project's agent config |
| `flow-code mcp` | Serve the reporting tools over MCP |
| `flow-code hook <event>` | Apply the current step's capabilities to a host tool call |
| `flow-code reconcile [runId] [--json]` | Check a run's claims against the repository |
| `flow-code validate` | Check .flow-code/workflow.yaml without running it |
| `flow-code node-types` | List built-in node types, capabilities, config and output shapes |
| `flow-code skills` | List skills attachable to a node, and where each was found |
| `flow-code doctor [--yes]` | Diagnose environment, tools, credentials; clear stale worktrees |
| `flow-code help` | Show this command reference |
| `flow-code --version, -v` | Print the installed version |
<!-- END GENERATED: cli-commands -->

This table is generated from the same source as `flow-code help`, which prints
the full detail on every flag.

## Two things worth knowing

**A second window can follow any run.** `flow-code watch` draws the same graph
read-only from anywhere that can read the repo; `flow-code status` compresses it
into a row sized for a status bar. See [Watching and
status](docs/observability.md).

**flow-code does not have to be the one running it.** That's the companion
setup above — the plugin or `flow-code connect`, whichever fits your agent.
See [Driving the graph from your own agent](docs/agent-integration.md) for what
you get less of, and exactly how much less.

## Documentation

| Guide | Covers |
| --- | --- |
| [Why a graph, not a chat log](docs/why-a-graph.md) | The thesis, the default graph node by node, the presets, and where it doesn't fit |
| [What a run costs](docs/cost.md) | Measured token figures, what they price out to, and how to spend less |
| [Glossary](docs/glossary.md) | driver, guest, harness, spine, enforcement tier — every term, defined once |
| [FAQ](docs/faq.md) | Windows, monorepos, non-git repos, CI, stuck runs |
| [Workflow reference](docs/workflow-reference.md) | Everything `workflow.yaml` accepts: edges, loop-backs, settings, budgets, worktrees, named graphs |
| [Node type reference](docs/node-types.md) | Every node type: capabilities, config fields, recorded output |
| [Providers and credentials](docs/providers.md) | Picking a provider, where the key lives, how a node's model is resolved |
| [Security and privacy](docs/security.md) | What is on disk, what is enforced, and what is not |
| [Keyboard and mouse](docs/keys.md) | The key map, and editing a node mid-run |
| [Watching and status](docs/observability.md) | Following a run from another window or a status line |
| [Driving the graph from your own agent](docs/agent-integration.md) | `connect`, enforcement tiers, and `reconcile` |
| [Skills](docs/skills.md) | Attaching custom `SKILL.md` instructions to a node |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the pull
request workflow.

## License

[MIT](LICENSE)
