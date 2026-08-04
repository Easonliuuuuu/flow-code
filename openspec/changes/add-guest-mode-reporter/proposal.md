## Why

Using flow-code today means giving up the agent CLI you already use: the engine owns the model connection, so the only way to get the graph is to stop running `claude`/`codex`/`opencode` and route everything through `flow-code run`. That is a switching cost paid up front, against tools people are attached to, and it is what makes flow-code read as "another agent CLI" rather than as a layer over the one you have.

`flow-code watch` already proved the graph does not need to own execution — it renders a run purely by reading `.flow-code/runs/<runId>.json`. The only reason a watcher stays blank next to a `claude` session is that nothing writes that file unless flow-code's own engine is running. This change gives an external agent a way to write it, which turns the viewer into "keep using your tool, get a graph" without a single new session runner.

**This proposal is deliberately not scheduled.** It captures the design while the reasoning is fresh; the work should be picked up only once driver mode is materially more mature and bug-free, since guest mode adds a second producer of run-state and doubles the surface that any run-state bug can appear on.

## What Changes

- **New MCP server** (`flow-code mcp`) exposing the run-state write surface as tools: open a run, transition a node, attach output, close a run. Registered once in the host agent's config; a tool in the tool list is far more salient to a model than a shell command it must remember to run.
- **New `flow-code node …` CLI** covering the same operations, for agents that cannot use MCP. Same validation, same file, no registration step.
- **New injected instructions** (a skill / `AGENTS.md` fragment, generated from the project's `workflow.yaml`) that teach a host agent the graph it is walking, the order of nodes, and what each node is expected to produce.
- **Transition validation**: reported transitions are checked against the loaded graph and rejected when illegal (starting a node whose upstream is not `done`, completing a node that never started, writing to a run another process owns). A guest that misreports gets an error it can act on, not a silently wrong graph.
- **New reconciliation check** comparing claimed node state against the actual git tree, surfacing nodes whose story does not match the diff. A graph that lies is worse than no graph, and unlike OpenSpec — which has the same agent-compliance problem and can only partly solve it — flow-code is already git-native and can check.
- **Honest degradation, stated in the UI**: a guest-driven run has no capability harness, no token accounting, and no engine-driven loop-backs. The viewer must say so rather than presenting a guest run as if it carried driver-mode guarantees.

Out of scope, deliberately: interactive approval gates in guest mode (a blocking `await_approval` tool answered from the watch window), parallel fan-out and convergence, and any new session runner. None are needed to make the graph light up beside an external agent.

## Capabilities

### New Capabilities
- `guest-run-reporting`: the run-state write surface for a process that is not flow-code's engine — MCP tools and the equivalent CLI, run lifecycle, transition validation, ownership rules that keep a guest from writing over a live driver-mode run, and the recorded provenance that marks a run as guest-driven.
- `guest-agent-instructions`: generating and installing the instructions that teach a host agent to walk the project's graph, and keeping them consistent with `workflow.yaml` as it changes.
- `run-state-reconciliation`: verifying reported node state against the repository's actual state and reporting disagreement, so an agent that skips its reporting duty is visible rather than invisible.

### Modified Capabilities
- `terminal-canvas-ui`: the viewer SHALL distinguish a guest-driven run from an engine-driven one, because the two carry different guarantees — a guest run has no capability enforcement and no token accounting, and rendering them identically would misrepresent what the graph is showing.

## Impact

- **Depends on `flow-code watch`**, which exists in the working tree but has no spec coverage of its own. That gap should be closed before this change is implemented, since the `terminal-canvas-ui` delta here builds on watch-mode requirements that are not yet written down.
- **New surface area**: an MCP server (new dependency on an MCP SDK), new CLI subcommands, and a generated instructions artifact checked into consuming projects.
- **`src/runstate/`**: a second writer of the run-state document. `RunStateStore` currently assumes a single owning process; ownership and concurrent-write rules become load-bearing rather than incidental.
- **`src/workflow/graph.ts`**: transition validation reuses the existing ordering and loop-back rules, applied to externally-reported transitions rather than to engine-driven ones.
- **Not affected**: `agent-execution` keeps its requirements unchanged. Guest mode does not weaken how flow-code executes nodes; it adds a path where flow-code does not execute them at all, and says so.
