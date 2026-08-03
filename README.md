# flow-code

[![CI](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

A terminal-native, node-graph interface for running and observing agentic coding workflows. Instead of a scrolling chat log, a coding task's lifecycle renders as a live, interactive graph in your terminal — spec discussion, implementation, validation, review, and git operations, each a node you can watch, pause on, or fan out across isolated git worktrees.

```
┌─────────┐    ┌───────────┐    ┌──────┐    ┌──────────┐    ┌────────┐    ┌──────┐    ┌─────────┐
│ Discuss │ ─▶ │ Implement │ ─▶ │ Test │ ─▶ │ Validate │ ─▶ │ Review │ ─▶ │ Gate │ ─▶ │ Git-ops │
└─────────┘    └───────────┘    └──────┘    └──────────┘    └────────┘    └──────┘    └─────────┘
                    ▲                             │
                    └───────── loop-back ──────────┘
                          (on a failing verdict)
```

Each box in that diagram is a live card in your terminal: a spinner while it runs, token counts, model badge, and a real-time subtitle of what the agent is doing.

## Quickstart

```bash
npm install
npm run build
node dist/cli.js init   # scaffold .flow-code/workflow.yaml and pick a provider/model
node dist/cli.js run    # run the workflow graph
```

Once installed globally or linked (`npm link`), the same commands are available as `flow-code init` / `flow-code run`. Run `flow-code help` for the full command list (`init`, `run`, `node-types`, `doctor`).

## Why flow-code

| | |
|---|---|
| **Live graph, not a log** | Watch spec discussion → implementation → test → validate → review → git-ops progress as nodes light up, instead of scrolling a chat transcript. |
| **Any provider** | Claude, NVIDIA NIM, OpenAI, or OpenRouter — one config backs every agent-driven node, with per-node overrides when you need them. |
| **Fan out safely** | Worktree-Agent nodes run work in isolated git worktrees, so parallel agents never step on each other's changes. |
| **Self-healing loops** | Loop-back edges send a failing `validate`/`review` verdict back upstream with the failure as context, bounded so it always terminates. |
| **Headless-ready** | `flow-code run` never prompts — CI picks up credentials from env vars with no wizard in the way. |

## Test command setup

Right after scaffolding `.flow-code/workflow.yaml`, `flow-code init` looks for how this project runs its tests — `package.json` scripts, a `Makefile` target, `pytest`/`go test`/`cargo test` markers — and offers each one it finds for you to accept or skip:

```
flow-code: created .flow-code/workflow.yaml
  Default graph: discuss → implement → test → validate → review → gate → git-ops

flow-code: set up the command(s) the Test node runs.

  Detected 2 possible test commands:
  Include `npm test`? [Y/n]
  Include `npm run test:e2e`? [Y/n]
  Add another test command? [y/N]
flow-code: saved 2 test commands to .flow-code/workflow.yaml.
```

Nothing detected (a brand-new project with no tests yet) just skips straight through, leaving the scaffolded placeholder (`echo "replace me with your project's test command"`) in place — a harmless no-op until you're ready to fill it in, by hand or by re-running `flow-code init`. Multiple commands run in order in the Test node; the first failing one stops it, so unit/integration/e2e levels can each be their own entry.

## Provider & model setup

One provider backs every agent-driven node in the project — Discuss, Implement, Validate, Review, Git-ops, and Worktree-Agent all run against whichever provider you pick. `flow-code init` walks through picking it right after the test-command step:

```
flow-code: pick the provider and model that will back every agent-driven node.

Provider:
❯ Claude (Anthropic)
  NVIDIA NIM
  OpenAI
  OpenRouter
```

Move with **↑/↓** (or **j/k**), confirm with **enter**, back out with **esc** or **ctrl+c** (nothing is saved on cancel). What happens next depends on the provider:

- **Claude**: no key prompt — it uses `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, or a `claude` CLI login. If none of those are detected yet, the wizard just warns you and keeps going; log in before your first `flow-code run`.
- **NVIDIA NIM** / **OpenAI** / **OpenRouter**: you're prompted to paste an API key (masked as you type), then asked whether to add a second key on a different account to rotate onto under sustained rate limits.

It then fetches the provider's live model list (a short curated list for Claude, since there's no key to query with at that point) and shows the same kind of picker, with a custom entry at the bottom for typing any model id — useful if the one you want isn't listed, or the fetch failed:

```
Model:
❯ gpt-4o
  gpt-4o-mini
  gpt-4-turbo
  (custom — type a model id)
```

Once picked, it's saved and confirmed:

```
flow-code: saved to .flow-code/credentials.json (gitignored, chmod 600).
flow-code: configured OpenAI / gpt-4o-mini for this project.
  Start a run with: flow-code run
```

From here, `flow-code run` is fully headless — it reuses the saved provider/model with no prompts, every time. Running `flow-code init` again just prints what's configured and asks whether to reconfigure — say no and it exits immediately, no flags to remember:

```
flow-code: provider already configured (OpenAI, model gpt-4o-mini).
  Reconfigure the provider/model? [y/N]
```

### Headless / CI usage

`flow-code run` never prompts. If `.flow-code/credentials.json` isn't present (e.g. a fresh CI checkout that never ran `init`), it falls back to whichever of these env vars is set, in this order — useful for setting up a provider without the interactive wizard at all:

- `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` → Claude (Anthropic)
- `NVIDIA_API_KEY` → NVIDIA NIM (get a free key at [build.nvidia.com](https://build.nvidia.com))
- `OPENAI_API_KEY` → OpenAI
- `OPENROUTER_API_KEY` → OpenRouter

If none of those are set and the workflow has any agent-driven node, `run` fails fast with a message pointing at `flow-code init` instead of hanging on a prompt.

### Overriding a node's model

The provider/model picked at `flow-code init` backs every agent-driven node by default, but any individual node — Discuss, Implement, Validate, Review, or Git-ops — can run on a different model from the same provider. Focus the node (tab) during a run and press **m** to open the picker; it lists the provider's models with the node's current model marked, moves with **↑/↓** (or **j/k**), confirms with **enter**, and cancels with **esc** without changing anything. If the provider's live model list can't be fetched, the picker falls back to typing a model id directly.

A confirmed choice is written to that node's `config.model` in `.flow-code/workflow.yaml` — comments and formatting elsewhere in the file are left alone — and, for a node that hasn't started yet, applies to the run in progress with no restart needed. On a node that's already `running` or `done`, the picker says the change applies next time rather than to the attempt already underway; the choice is still saved, so a loop-back re-run picks it up. Selecting the model the node would already be using (the workflow's `settings.model`, or the provider default if that's unset) clears the override rather than writing a redundant one.

A node running on something other than the project default carries a small badge on its box naming the model — click it (or press **m** while that node is focused) to change it. Test and Approval-Gate nodes run no agent session and have no model to pick; Worktree-Agent sets a model per fan-out instance in its own config rather than one for the whole node, so it isn't covered by this picker either — edit `workflow.yaml` directly for those.

## Configuring a workflow

Workflows are defined per-project in `.flow-code/workflow.yaml`. The full schema — node types, capabilities, edges, and run settings — is documented in [`openspec/specs/workflow-graph/spec.md`](openspec/specs/workflow-graph/spec.md), which is the source of truth for the config format.

### Iterating on failure

Validate and Review fail their node when they return a `fail` verdict, which by default stops the run there. To iterate instead of stopping, add a **loop-back edge**: when its `from` node fails, execution returns to its `to` node and re-runs every node on the path between them, with the failure injected as context so the retry knows what to fix.

```yaml
edges:
  - { from: implement, to: validate }
  # On a failing verdict, go back to implement and try again.
  - { from: validate, to: implement, loopback: true }
  # Or set the bound explicitly:
  - { from: validate, to: implement, loopback: { maxAttempts: 5 } }
```

A loop-back must point back to a node upstream of its source — this is checked before the run starts. Every loop-back is bounded (`maxAttempts` defaults to **3**, counted per target node), so a loop that never converges still terminates: the failing node stays in `error`, its downstream nodes are skipped, and the status detail says the attempt limit was reached. Loop-backs are drawn as return paths below the graph, and a node that has been re-run carries a `↻N` badge.

A rejected Approval-Gate works the same way: with a loop-back declared it sends the segment back for another pass, and without one it halts the branch as before.

### Budgets: what a run is allowed to cost

A workflow that can retry is a workflow that can spend without bound, so `settings.budget` says when to stop. Every field is optional, and an unset field is unbounded — an existing workflow behaves exactly as it did.

```yaml
settings:
  budget:
    tokensPerNode: 300000   # one node, across all of its attempts
    tokensPerRun: 2000000   # the whole run
    minutesPerRun: 60       # wall clock
```

A per-node breach aborts that node's session and fails it, leaving the rest of the graph free to finish and report. A run-wide breach aborts everything in flight and starts nothing new. Either way the status detail names the ceiling and what was spent against it.

**A budget stop never retries**, even where a loop-back is declared: retrying past a ceiling is precisely what the ceiling exists to prevent. Token counts are live — a running node shows `↑prompt ↓completion` on its card, and the header carries the run total.

### Specs and acceptance criteria

A **Spec** node turns the intent settled upstream (usually by a Discuss node) into a durable contract: `.flow-code/specs/<runId>.md`, plus numbered acceptance criteria that flow downstream as context.

```yaml
nodes:
  - id: spec
    type: spec
    # Or write it by hand and skip the agent call entirely:
    # config:
    #   title: What we're building
    #   acceptanceCriteria:
    #     - Running `foo --bar` prints the parsed config and exits 0

edges:
  - { from: discuss, to: spec }
  - { from: spec, to: implement }
  - { from: spec, to: validate }   # Validate needs the criteria, so wire them to it
```

Where a Validate node receives acceptance criteria, it answers them one at a time (`{id, met, evidence}`) and **its verdict is computed from those answers, not asserted**: any criterion reported unmet — or simply not reported — fails the node, whatever the model concluded in prose. That is what makes a spec a stop rule rather than a suggestion, and what gives a loop-back a real termination condition to converge on.

The spec file is written by flow-code itself, never by an agent, and no node can edit it afterwards (see below). It also sits *outside* the segment a loop-back resets, so every retry is judged against the same criteria the first attempt was.

### Conditional edges

An edge with a `when` still waits for its source, but only carries when the condition holds:

```yaml
edges:
  - { from: implement, to: gate, when: "implement.changedFiles isNotEmpty" }
  - { from: review, to: rework, when: "review.findings.length > 0" }
  - { from: test, to: triage, when: "test.passed == false" }
```

A condition reads `<node>.<field>` from a node's recorded output — the edge's own source, or anything upstream of it. Operators: `==` `!=` `>` `<` `>=` `<=` `contains` `isEmpty` `isNotEmpty`; values are quoted strings, numbers, `true`/`false`/`null`; `.length` works on arrays and strings. One condition per edge — use two edges for two conditions. Everything is parsed and checked when the workflow loads, so a typo is a validation error rather than an edge that silently never fires.

When a condition does not hold, its target is skipped along with the rest of that branch — but a node the branches rejoin at still runs, as long as some other path into it was taken. A branch that was *not taken* clears the way; a branch that *failed* still blocks, exactly as before.

### The control directory is an anchor

No node can write into `.flow-code/` — not the workflow file, not credentials, not the specs. The harness denies edit-tool writes whose path lands there and shell commands that name a control artifact, on both the Claude and the OpenAI-compatible paths, and every denial is logged like any other. Reading stays available.

This is deliberate: a node that could edit `.flow-code/workflow.yaml` could raise its own attempt limit, rewrite the Test node's commands, grant itself capabilities, or soften the acceptance criteria it is about to be judged against. The things that define and verify a run have to be things the run cannot move. (A Worktree-Agent instance is unaffected inside its own worktree — the rule is relative to each node's working directory.)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch/PR workflow, CI, and the NVIDIA integration test suite.

## License

MIT
