## Why

The engine can express a pipeline but not a loop. A spike that expressed the OpenSpec spec-driven lifecycle (propose → apply → verify → sync → archive) on today's built-in node types loaded and ordered correctly, then failed in three places at runtime:

1. **Verdicts are advisory.** Running the graph with both Validate and Review returning `verdict: "fail"` produced eleven `done` nodes and reached the Git-ops node. `executeValidate` and `executeReview` yield `status: 'done'` unconditionally after parsing their output, and the engine branches only on status, never on output content. Today the only thing standing between a failed review and a commit is the human at the Approval-Gate.
2. **Approval-Gates erase context.** Because a node receives only its *direct* dependencies' outputs, and `approvalGateOutput` is `{decision, decidedAt}`, the node after a gate receives exactly `{"decision":"approved","decidedAt":"…"}`. In the spike the Implement node downstream of the proposal gate had no idea which change it was implementing. This also affects the shipped default workflow, where Git-ops sits after a gate and receives only the decision.
3. **Failure can only stop, never retry.** A failing node marks everything downstream `skipped` and the run ends. There is no way to route a failed Test, Validate, or Review back to the Implement node that caused it — which is the single most common thing a real coding workflow needs to do.

The third is the one that matters most: an agentic coding workflow that cannot iterate is a workflow that hands every failure back to the human. Fixing it requires the first two, because a loop needs a failure signal to trigger it and needs context to survive the trip back.

## What Changes

- **Context-transparent node types.** A node type may declare itself context-transparent; such a node forwards its direct dependencies' outputs alongside its own recorded output. Approval-Gate becomes context-transparent. Context stays bounded by fan-in — indirect ancestors are still not propagated — so the existing rationale is preserved.
- **Output-conditional failure.** A node type may declare a failure predicate over its own recorded output. Validate and Review declare `verdict == "fail"`, so a failing verdict produces node status `error` instead of `done`. The predicate lives on the node *type*, not on the edge: the node decides whether it succeeded, and the graph stays dumb.
- **Loop-back edges.** An edge may be declared as a loop-back, naming an upstream target and a bounded attempt limit. When the source node fails, the engine resets the target node and everything between it and the source, then re-runs that segment with the failure recorded as context. Exceeding the attempt limit fails the run rather than looping forever.
- **Attempt tracking in run-state.** Each node records how many attempts it has taken and retains the terminal status of prior attempts, so a resumed or inspected run shows the loop's history rather than only its latest pass.
- **Loop visualization.** The terminal canvas renders loop-back edges as visually distinct return paths routed around the forward layout, and shows an attempt badge on any node that has run more than once.
- **BREAKING**: the graph is no longer required to be acyclic in the raw edge set. Acyclicity is now required of the forward-edge subgraph only. Workflow files that were valid before remain valid.

## Capabilities

### New Capabilities

None. All three changes extend behavior owned by existing capabilities.

### Modified Capabilities

- `agent-execution`: upstream output propagation gains pass-through semantics; the node output contract gains output-conditional failure; new requirements for loop-back re-execution, attempt bounds, and failure context on retry.
- `workflow-graph`: graph structural validation changes from "acyclic" to "acyclic over forward edges"; edges gain an optional loop-back declaration; the node type registry gains the context-transparency and failure-predicate fields.
- `terminal-canvas-ui`: live graph rendering gains loop-back edge rendering and per-node attempt indication.

## Impact

- `src/engine/engine.ts` — the scheduler: `upstreamInputs`, `runNode`, `startEligible`, `markDownstreamSkipped`, and the `allTerminal` termination condition all assume a node runs at most once.
- `src/workflow/schema.ts`, `src/workflow/load.ts`, `src/workflow/graph.ts` — edge schema, forward/back edge partitioning, topological order over forward edges only.
- `src/registry/types.ts`, `src/registry/index.ts` — two new optional fields on `NodeTypeDefinition`; Validate, Review, and Approval-Gate declare them.
- `src/runstate/types.ts`, `src/runstate/store.ts` — attempt counter and prior-attempt history; node reset must clear output and live output without losing the log.
- `src/ui/layout.ts`, `src/ui/canvas.ts` — `computeLayout` derives layers via longest-path over dependencies and will not terminate on a cyclic edge set; back edges must be excluded from layering and routed separately.
- `src/executors/agents.ts` — Validate and Review stop hard-coding `done`.
- No change to the capability model, the harness, or any node's permissions.
