## Context

`Engine` (`src/engine/engine.ts`) is a single-pass DAG scheduler. It walks `workflow.order` — a topological order computed once at load — and starts any node whose direct dependencies are `done`. Every node runs at most once: `runNode` writes a terminal status, `markDownstreamSkipped` handles failure by killing the rest of the branch, and `allTerminal()` ends the run when no node is left in a non-terminal state. Three assumptions are baked into that loop and all three have to be revisited here:

1. a node's status is a function of whether its executor threw, not of what it produced;
2. a node's context is exactly its direct dependencies' recorded outputs;
3. a node transitions `idle → terminal` exactly once, so "terminal" is a safe stopping condition.

The layout code (`src/ui/layout.ts`) shares assumption 3 in a different form: `computeLayout` assigns each node a layer as `max(dep.layer) + 1` over `workflow.order`, which is only well-defined because the edge set is acyclic.

The capability harness, the executors' internals, and the run-state persistence format are not otherwise involved. Nothing in this change alters what an agent session is permitted to do.

## Goals / Non-Goals

**Goals:**

- A failing verdict from Validate or Review fails its node, without any executor needing to hard-code that logic.
- Inserting an Approval-Gate into a graph does not destroy the context of everything after it.
- A failed Test, Validate, Review, or rejected gate can route back to an upstream node and re-run the segment, bounded by an attempt limit.
- The loop is legible in the terminal canvas: the return path is drawn, and a re-run node shows which attempt it is on.
- Runs that declare no loop-back edges behave exactly as they do today.

**Non-Goals:**

- User-defined or declarative custom node types. This change adds two fields to `NodeTypeDefinition`; opening the registry to workflow-declared types is separate work.
- Arbitrary conditional branching (`if verdict == X go to A else go to B`). The only conditional control flow introduced is failure-triggered loop-back.
- Resuming a run mid-loop from `--resume` with perfect fidelity beyond what attempt history already records.
- Any change to concurrency. Loop-back segments re-run under the same main-tree serialization as the first pass.

## Decisions

### Failure predicates live on the node type, not the edge

`NodeTypeDefinition` gains an optional `failsWhen?: (output: unknown) => boolean`. The engine evaluates it in `runNode` after the output has been validated against `outputSchema`, and overrides the terminal status to `error` when it holds. Validate and Review declare `(o) => o.verdict === 'fail'`; `executeValidate` and `executeReview` stop yielding `status: 'done'` and simply yield their result.

*Why not on the edge:* the existing `workflow-graph` spec requires that edges carry no behavior, and the rationale is sound — a graph-rendering tool should not hide decisions inside edge annotations. "Did this node succeed?" is knowledge the node type owns; the graph only routes the answer.

*Why a predicate function rather than a YAML expression:* the registry is TypeScript today and every failure predicate is written by us. A string expression language would be an unforced dependency, and would need a sandbox. When the registry opens to user-declared types, a restricted expression form can be added then.

*Alternative rejected:* having each executor yield `status: 'error'` itself. That works, but it scatters the pass/fail rule across executors, makes it invisible to `flow-code node-types`, and gives the engine no way to know a node type is fallible before running it.

### Context transparency is a type flag, and forwarding is computed at read time

`NodeTypeDefinition` gains `contextTransparent?: boolean`; Approval-Gate sets it. `Engine.upstreamInputs` changes from "map over direct dependencies" to a short walk: for each direct dependency, include its output, and if that dependency's type is context-transparent, recurse into *its* direct dependencies. Results are de-duplicated by node id, and the existing `UPSTREAM_OUTPUT_LIMIT` truncation applies to the assembled set.

*Why not propagate all ancestors:* the current spec explicitly forbids it, with the rationale that context growth should be bounded by fan-in rather than graph depth. That rationale is right and this preserves it — the walk only crosses nodes that declare themselves transparent, and a gate has fan-in 1 in every realistic graph.

*Why not give the gate a fatter output schema* (e.g. have it copy its upstream outputs into `approvalGateOutput`): it would duplicate potentially large payloads into run-state on every gate, and would make the gate's own output schema depend on whatever happens to sit upstream of it.

*Trade-off:* a transparent node with high fan-in could assemble a large context. The size limit already handles this, and no built-in transparent type has high fan-in.

### Loop-back is an edge property, and it is the one exception to "edges carry no behavior"

The edge schema gains `loopback?: { maxAttempts?: number }`, defaulting to a documented bound. `Graph` partitions edges into forward and loop-back sets at construction; `directDependencies`, `topologicalOrder`, and `depsSatisfied` all operate on forward edges only, so a loop-back never makes its target wait.

*Why on the edge:* a loop-back genuinely is a graph edge — it has two endpoints, it must be drawn, and it is the user's routing decision rather than the node type's. Expressing it as node config (`onFailure: { retryFrom: implement }`) would hide a visible edge inside a node's configuration, which is exactly backwards for a tool whose entire premise is that the graph is the interface.

The `workflow-graph` requirement is therefore narrowed rather than abandoned: edges may declare *structure*, never *behavior*. Whether a node failed is still the node type's call; the loop-back edge only says where a failure routes. This is a deliberate revision of an existing invariant and is called out as such in the delta spec.

*Validation:* a loop-back target must be an ancestor of the source over the forward subgraph, checked at load time. Without that check a "loop-back" could point sideways or forwards and the reset semantics would be undefined.

### Reset scope is the path set between target and source

When node `S` fails and a loop-back `S → T` exists, the reset set is `{T} ∪ (descendants(T) ∩ ancestors(S)) ∪ {S}` over forward edges. Every node in that set returns to `idle` with output, status detail, and live output cleared; the activity log is retained, since it is append-only and is the audit record of what actually ran.

*Why a path set rather than "everything downstream of T":* a branch that hangs off `T` but does not lead to `S` had nothing to do with the failure and may have already produced results the user cares about. Only work that fed the failure is redone.

*Why not reset `S` itself to `idle` and let it re-run immediately:* it is in the set, but it only becomes eligible once its dependencies are `done` again, which is what makes the segment re-run in order.

### The failure reason is injected as retry context

When the loop fires, the engine records the failing node's output and status detail on the run and injects it into the loop-back target's next context, labelled as the retry reason. Without this the re-run is identical to the first run and will produce an identical failure — the loop would be pure cost.

### Termination is by attempt bound, checked before the reset

Each node's run-state gains `attempt: number` and `priorAttempts: Array<{ status, detail?, endedAt }>`. A loop-back fires only if the *target's* attempt count is below the edge's `maxAttempts`. When the bound is hit, the loop does not fire: `S` stays `error` and `markDownstreamSkipped` runs as it does today, with a detail naming the attempt limit.

`allTerminal()` remains the stopping condition and stays correct, because the reset happens inside `runNode`'s failure path before the scheduler re-evaluates. Total node executions are bounded by `sum(maxAttempts)` over loop-backs times the segment size.

*Alternative rejected:* a global run-level step budget. Simpler to implement, but it fails the whole run for reasons a user cannot attribute to any particular loop.

### Layout excludes loop-back edges; rendering routes them separately

`computeLayout` layers over forward edges only, so node positions are unchanged by the presence of a loop-back. `renderGraph` draws loop-back edges in a second pass, routed below the box rows with a distinct glyph run and style, so a return path never collides with the forward elbow between the same two nodes. A node with `attempt > 1` renders an attempt badge in its box.

*Why not route above:* the box rows already reserve space below for the elbow midlines; below keeps the change local to the existing routing code.

## Risks / Trade-offs

- **A loop that never converges burns tokens up to its bound.** → Bounds are mandatory with a conservative documented default, the reason for each retry is injected so attempts differ, and the attempt badge makes a thrashing loop visible in the canvas rather than silent.
- **Resetting nodes discards recorded output that a user may have been reading.** → Prior attempts' terminal statuses are retained in `priorAttempts` and surfaced in the detail view; the activity log is never cleared.
- **`allTerminal()` could deadlock if a reset leaves a node `idle` with an unsatisfiable dependency.** → The reset set is closed under paths from `T` to `S`, so every reset node's forward dependencies are either outside the set and `done`, or inside the set and scheduled. Covered by an explicit termination test.
- **Verdict-driven failure changes behavior of existing workflows.** → It does: a workflow that previously ran to completion with a failing review will now stop at the review. That is the intended fix, and it is the reason this is marked breaking in the proposal. The default scaffolded workflow gains no loop-back, so its failure mode becomes "stops at review" rather than "commits anyway".
- **`--resume` interacts with a partially-looped run.** → Attempt counters persist with the rest of run-state; resume restores them and continues. Resuming *into* the middle of a reset is not possible because the reset is synchronous within `runNode`.
- **Rendering back-edges in a character grid is fiddly for long spans.** → The route is a single horizontal run at a reserved row plus two vertical stubs; overlapping loop-backs share the row band and are tested at the grid level like existing edge rendering.

## Migration Plan

No data migration. Run-state gains optional fields, and a run-state file written before this change loads with `attempt` defaulting to 1 and no prior attempts. Existing `.flow-code/workflow.yaml` files remain valid and behave identically, except that a failing Validate or Review now stops the run instead of continuing — which requires no file change to adopt.

## Open Questions

- Should the default scaffolded workflow ship with a loop-back from `validate` back to `implement`? It demonstrates the feature immediately, but makes the zero-config experience spend tokens on retries. Leaning toward shipping it commented out.
- Should a rejected Approval-Gate with no loop-back edge continue to skip downstream nodes, or should reject become re-runnable by default? Current spec keeps skip as the default and makes loop-back opt-in.
- Is `maxAttempts` best counted per loop-back edge or per target node when several loop-backs share a target? Currently per target node, which is the conservative reading.
