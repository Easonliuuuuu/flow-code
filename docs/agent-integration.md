# Driving the graph from your own agent

`flow-code run` executing the graph is not the only way to use it. You can stay in the agent CLI you already use — `claude`, `codex`, whatever it is — walk the graph yourself, and have the run fill in beside you:

```bash
flow-code connect   # once per project: installs the tools and the instructions
flow-code watch     # second window — the graph fills in as your session reports
```

`connect` writes four things and names each one: an MCP server entry in `.mcp.json`, a skill at `.claude/skills/flow-code-workflow/SKILL.md`, a delimited section in your `CLAUDE.md`/`AGENTS.md`, and a `PreToolUse` hook in `.claude/settings.json`. It only ever edits inside its own delimiters or its own entries, leaving the rest of each file byte-identical. Run it again after changing `workflow.yaml`; `flow-code connect --check` reports what is installed and whether it still matches.

For Claude Code specifically there is a plugin, which needs no per-project step at all — it reads the graph through a tool rather than installing a copy of it:

```
/plugin marketplace add Easonliuuuuu/flow-code
/plugin install flow-code
```

Either way your agent reports each transition (`flow-code node start <id>`, `… done <id> --output '{…}'`, `… fail <id> <reason>`), and every one is checked against the graph before it is recorded. A step cannot start before the steps above it are done, cannot complete without having started, and cannot complete with output that does not match its node type's shape. A rejected report changes nothing and says why.

## A graph that does not know its own shape yet

A graph can start out as a Plan node and nothing else decided. The Plan node's output *is* a graph — nodes and edges in exactly the shape a workflow file's are — and reporting it complete splices that proposal into the run in place of the node's own successors. The steps your agent planned become real nodes it can report against:

```bash
flow-code node done plan --output '{"nodes":[{"id":"impl","type":"implement","config":{"instructions":"…"}}],"edges":[]}'
# flow-code: plan → done
#   the run now holds: plan → impl → gate → ship
```

The proposal is built and validated before anything is written, by the same code path `flow-code run` uses, so a graph one accepts is never one the other refuses. That includes the rule that matters most here: **a proposal that reaches a git-writing node without passing an Approval-Gate is refused.** An agent cannot plan its way around the gate. A refusal leaves the run exactly as it was — the Plan node stays `running`, free to propose again — and says which node and which path is at fault.

Because the nodes that result are in no instructions your agent has read, both reporting surfaces hand back the ids the run now holds. Those, not the brief, are what to walk from there.

Expanding changes nothing about enforcement: a run that expands is reported at whatever tier it already held.

## What a reported run is, and is not

flow-code validates the *order* of what an outside agent reports. It does not execute that agent, so it cannot enforce anything about what the agent actually did. Runs record which of three tiers they ran under, and every surface that displays a run says which:

| Tier | What is in force |
| --- | --- |
| **engine** | `flow-code run`: capability enforcement, process guards, per-node models, token accounting, loop-back routing. |
| **host session** | A session flow-code did not start, with its enforcement layer active: the same tool policy and git interception, and nothing that depends on having spawned the process. |
| **reported** | Self-reported. Transitions are checked against the graph; the work behind them is not. |

Both non-engine tiers are labelled in the viewer on a line of its own and show spend as `n/a` rather than as zero — a run should not be able to display guarantees it never had. **A green graph from a `reported` run is a record of what your agent said it did, not evidence that anything was checked.**

## What the enforcement layer actually does

While a step is in progress, the hook applies *that step's* capability set to your session's tool calls, using the same policy function `flow-code run` compiles — a review step cannot edit files, and nothing can write to the repository while an approval gate above it is unanswered. The envelope moves as the run advances, with no session restart. Denials are recorded on the run, so the viewer's blocked-action indicator means the same thing either way.

Three things make the claim honest rather than decorative:

- **It fails closed.** If the layer errors, or cannot work out which step is in progress, the call is denied — and the reason says "could not determine", distinctly from "this step may not do that", because an agent that cannot tell those apart routes around the wrong one.
- **It is verified, not assumed.** A run records the `hooks` tier only while a heartbeat the hook itself just wrote is fresh. An installed plugin proves nothing: hooks can be turned off afterwards. If enforcement stops mid-run the downgrade is recorded with its point, and the run is reported at its weakest tier from then on.
- **A gate decision comes from a person.** `complete_node` refuses approval gates outright, so an agent has no path to approving its own work. The MCP tool that records one is annotated `requiresUserInteraction`, which forces its full permission prompt — no allow-rule bypass, and refused rather than passed in a non-interactive mode. On the CLI, `flow-code node approve <id>` requires an interactive terminal. Which surface collected a decision is recorded on the run, because `terminal` and `permission-prompt` are not the same evidence.

What stays out of reach, because flow-code did not start the process: per-node model selection, exact token accounting, and the process-level guards (working directory, environment, the push-url block). Loop-backs are the one place a host-session run is structurally different rather than merely less enforced — the engine *routes* a failure back to its target, and a hook can only decline to end a turn. The generated instructions say so, and tell the agent to walk the return path itself.

Enforcement is evadable through indirection — a script that shells out to git from inside another program — exactly as it is under `flow-code run`, which intercepts the same calls with the same parser. It is a boundary against accident, not against an adversary.

## Asking the repository whether the run is true

Enforcement narrows what an agent may *do*. It says nothing about what an agent *says* it did — and a graph that confidently shows work nobody performed is worse than a graph showing nothing. The tree is the one witness that does not depend on the agent's honesty:

```bash
flow-code reconcile            # the latest run; `reconcile <runId>` for a specific one
```

```
run 9bdf1d06 — checked against the repository
  1 claim(s) the repository does not support:
    implement: reported changing `src/a.ts`, but it is unchanged from the run's baseline
  skipped check — Test does not modify the repository
```

It compares each completed node's own recorded output against the run's baseline — the files it said it changed, the spec it said it wrote, the commit it said it made — so a finding is something you can check in one command rather than a vague "the tree looks wrong". Nodes whose type cannot modify the repository are skipped rather than flagged for doing their job, and a run with no baseline is reported as *unreconcilable* rather than as agreement: the absence of a check is not a clean bill of health.

It exits non-zero when the repository contradicts the run, so it works as a check and not only as something to read. It never writes the run document — findings go to `.flow-code/reconcile/<runId>.json`, and `flow-code watch` picks them up from there and names the affected nodes in its header. And it never corrects anything: the tree cannot say *why* a claim is unsupported (a node may legitimately have been a no-op, or you may have reverted something by hand), so resolving the disagreement is yours.
