## Why

Every flow-code run executes a graph a human wrote — the default scaffold, a preset, or a hand-edited file. That graph is fixed for the whole run: a node cannot add a node, so when the shape turns out wrong the run can only loop back along edges the author happened to draw. The consequence is that one graph has to fit every task the repo will ever run, and it gets sized for the hardest one. A one-line typo fix pays for Spec, Validate, and Review because a twelve-file refactor needs them.

The shape of a coding task is knowable before the run — from a conversation with the person asking for it. flow-code already has the node for that conversation and already makes it interactive. What it does not have is a way for that conversation to produce the graph. Adding one buys per-task shape without giving up what the project is built on. The claim gets stronger, not weaker: not *a graph you can read before it runs*, but **a graph you agreed to before it runs**.

## What Changes

- **A new `plan` node type.** Interactive and read-only, like Discuss. The user and the agent converge on both what is being built and the graph that builds it; the node does not complete until the user accepts a proposed graph. Its output is a set of nodes and edges rather than text for a downstream node to read.
- **Graph expansion at the plan node.** When a Plan node completes, the graph it produced is spliced between it and its successors, recorded to the run document, and execution continues into it. The run's graph is determined after its first node, not at load.
- **A `planned` preset.** `flow-code init` gains it alongside `openspec` and `spec-kit`, scaffolding a three-node spine — `plan → approval-gate → git-ops` — and nothing else. No new CLI surface: `init` and `run` remain the whole command set a user needs.
- **The planner composes existing node types only.** It chooses node count, ids, per-node `instructions`, fan-out, which loop-backs exist and their bounds, and per-node `model` and `budget`. It introduces no node type and no capability — including that it may place a Discuss node in the graph it emits when a task warrants more conversation.
- **Expanded graphs are validated before they run.** A proposed graph goes through the same node type, config, settings, and structural checks a workflow file goes through. Invalid proposals are fed the failures and reproposed, never executed.
- **Keeping a planned graph.** After a run, the expanded graph can be written back to `.flow-code/workflow.yaml`, so a shape worth reusing becomes an ordinary static workflow and the next run needs no planning at all.
- **BREAKING — the gate invariant becomes structural.** Validation gains a check that any node holding the `git-write` capability is dominated by an Approval-Gate: every path from every root to it passes through one. Today nothing enforces this — `withGateApprovalConditions` only attaches an approval condition to edges *leaving* a gate, so a workflow whose Git-ops node has no gate upstream loads and commits without ever asking. Hand-written that is an author's mistake; produced by a planner it would make the safety property something the model opts into. Existing workflow files with an ungated git-writing node will fail to load until a gate is added.

## Capabilities

### New Capabilities
- `plan-node`: the Plan node type — its interactive graph negotiation, the vocabulary it may draw from, the validation its proposal must pass, how the graph it produces is spliced into the run, and what happens when planning is rejected, fails, or is interrupted.

### Modified Capabilities
- `workflow-graph`: the built-in node type registry gains Plan; graph structural validation gains the git-write-requires-gate-dominance invariant, plus the structural constraints a Plan node carries (at most one, and it must be a root); the preset requirement gains the `planned` preset.
- `run-state`: the recorded graph is replaced when a Plan node expands it, rather than being written once at run start and never again.
- `terminal-canvas-ui`: the canvas gains nodes mid-run, so layout and viewport must survive a graph growing from three nodes to N after the first node completes.

## Impact

- `src/registry/index.ts` — the Plan type: `read` capability, `interactive: true`, role prompt, and an output schema describing nodes and edges.
- `src/executors/` — a plan executor, built on the interactive session path Discuss already uses (`openInteractive`), plus the propose-validate-repropose loop.
- `src/workflow/load.ts` — the gate dominance check and the Plan node structural constraints, in the existing structure stage so they report alongside the loop-back, `test: auto`, and condition checks.
- `src/workflow/graph.ts` — a dominator computation over the forward-edge subgraph.
- `src/engine/engine.ts`, `src/cli/run.ts` — graph expansion: rebuild the workflow, `recordGraph`, and continue with completed node state carried forward. `RunStateStore` already accepts `{graph, resumeFrom}`, which is most of it.
- `src/runstate/` — recording a graph replacement, and keeping node state attributed across it.
- `src/ui/` — a graph that grows after the first node completes.
- `src/presets.ts` — the `planned` preset, a constant three-node file.
- `docs/workflow-reference.md`, `docs/node-types.md` (generated) — the invariant, the preset, and the new type.
- Existing workflow files in the wild — any with an ungated git-writing node stop loading, with no opt-out. The error must name the node, the path that misses a gate, and the alternative for an unattended run: remove the git-writing node and commit from the pipeline after `flow-code run` exits.

### Out of scope

- **A Plan node anywhere but the graph's root.** One Plan node, and it must be a root. Expanding over nodes that are already running, or into another Plan node, raises questions worth answering later and not now.
- **A runtime agent loop.** Letting a node call Test or Validate as tools rather than occupying graph positions is a different change that gives up reading the graph at all. This proposal keeps the graph.
- **Replanning after execution has begun.** Once the expanded graph runs, it is fixed for that run, exactly as a hand-written graph is. The answer to a graph that turned out wrong is another run, which replans from the start.
