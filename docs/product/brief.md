# Product brief

> **Status: draft, inferred.** This was drafted from the README, the shipped
> code, and the reasoning in existing OpenSpec proposals. The description of
> what flow-code *is* should be accurate; the parts about who it is for and
> what is deliberately out of scope are inference and need your correction.
> Everything downstream — the roadmap, the status rollup — hangs off this file,
> so it is worth arguing with.

## What it is

flow-code is a terminal-native node-graph interface for running and observing
agentic coding workflows. A coding task runs as a graph you can watch: each step
is a live card showing status, token spend, model, and streaming output. Steps
that fail route back upstream and retry. Nothing reaches git without explicit
approval.

## The problem it exists to solve

Agentic coding today is a scrolling chat log. That format hides three things
that matter once a task is longer than a few minutes:

- **Where you are.** A log shows the most recent thing, not the shape of the
  work or how much of it remains.
- **What it cost.** Token spend and model choice are invisible until the bill.
- **What it is about to do.** Work reaches git because the agent decided it was
  finished, not because you agreed it was.

A graph makes the first legible, per-node budgets make the second legible, and
an explicit gate makes the third a decision rather than a default.

## Who it is for

*(Inferred — correct this.)* Developers who already run an agentic coding CLI
(`claude`, `codex`, `opencode`) on real repositories, who have hit the point
where a long autonomous run is more anxiety than leverage, and who want
observability and a stopping point without giving up autonomy.

The distinguishing trait is not team size or seniority — it is running agents on
code you are accountable for.

## What it is not

*(Inferred — correct this.)*

- **Not another agent CLI.** The graph is a layer over execution, not a
  competing model connection. The `watch` command and the parked guest-mode
  proposal both point the same direction: keep the tool you use, get the graph.
- **Not a CI system.** It observes and gates an interactive run at your terminal.
  It is not trying to be the thing that runs on merge.
- **Not a project-management tool.** The graph tracks one run. Tracking work
  across runs is what `docs/product/` and OpenSpec are for.

## What "good" looks like

A run where you could leave the terminal for ten minutes, come back, and know
from one screen what happened, what it cost, and whether it is safe to let
continue — without reading a transcript.

## Guiding constraints

These are the commitments that existing specs and proposals already enforce.
They are listed here because they are the things a new change is most likely to
violate by accident.

1. **A verdict is never a model's opinion when it can be a fact.** The Test node
   reports an exit code. Reconciliation checks the git tree.
2. **Never present a weaker guarantee as a stronger one.** If a run has no
   capability harness or no token accounting, the UI says so. A graph that lies
   is worse than no graph.
3. **Nothing reaches git without explicit approval.**
4. **Every node is optional and rewireable.** The scaffolded graph is a default,
   not the product.
