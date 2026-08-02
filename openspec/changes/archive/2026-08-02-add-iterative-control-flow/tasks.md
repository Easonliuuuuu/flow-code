## 1. Registry fields and verdict-driven failure

- [x] 1.1 Add optional `failsWhen?: (output: unknown) => boolean` and `contextTransparent?: boolean` to `NodeTypeDefinition` in `src/registry/types.ts`
- [x] 1.2 Declare `failsWhen` on the Validate and Review definitions in `src/registry/index.ts` (`output.verdict === 'fail'`)
- [x] 1.3 Declare `contextTransparent: true` on the Approval-Gate definition
- [x] 1.4 Evaluate `failsWhen` in `Engine.runNode` after the output passes `outputSchema`, overriding the terminal status to `error` with a detail naming the verdict
- [x] 1.5 Remove the unconditional `yield { type: 'status', status: 'done' }` from `executeValidate` and `executeReview` in `src/executors/agents.ts`
- [x] 1.6 Surface fallibility in `flow-code node-types` output so a type that can fail on its own verdict says so
- [x] 1.7 Tests: a failing verdict yields node status `error` with the output still recorded; a passing verdict yields `done`; a node type with no predicate is unaffected

## 2. Context propagation across transparent nodes

- [x] 2.1 Rewrite `Engine.upstreamInputs` to walk through context-transparent dependencies, collecting their direct dependencies' outputs
- [x] 2.2 De-duplicate collected outputs by node id so diamond paths inject each output once
- [x] 2.3 Apply the existing `UPSTREAM_OUTPUT_LIMIT` truncation to the assembled set, preserving the truncation marker behavior
- [x] 2.4 Tests: a node after an Approval-Gate receives both the gate decision and the gate's upstream outputs; chained transparent nodes compose; non-transparent ancestors are still not propagated; oversized forwarded context is truncated
- [x] 2.5 Regression test that the shipped default workflow's Git-ops node now receives the review and gate context

## 3. Loop-back edges in the workflow schema and graph

- [x] 3.1 Extend `edgeSchema` in `src/workflow/schema.ts` with `loopback?: { maxAttempts?: number }` and a documented default bound, keeping `strictObject` so unknown edge keys still fail
- [x] 3.2 Partition edges into forward and loop-back sets in the `Graph` constructor (`src/workflow/graph.ts`); keep `directDependencies`, `directDependents`, `downstreamOf`, `ancestorsOf`, and `topologicalOrder` operating on forward edges only
- [x] 3.3 Add `loopbacksFrom(nodeId)` and a forward-edge path-set helper for computing the reset scope
- [x] 3.4 Validate in `src/workflow/load.ts` that every loop-back target is a forward-edge ancestor of its source, failing with an error naming the edge
- [x] 3.5 Validate that `maxAttempts` is a positive integer, failing with the edge name and offending value
- [x] 3.6 Tests: a graph with a loop-back loads and topologically orders over forward edges; a loop-back to a non-ancestor fails validation; a forward-edge cycle still fails; an unknown edge property still fails

## 4. Attempt tracking in run-state

- [x] 4.1 Add `attempt: number` and `priorAttempts: Array<{ status, detail?, endedAt }>` to `NodeRunState` in `src/runstate/types.ts`
- [x] 4.2 Add a `resetNode(nodeId)` method to `RunStateStore` that clears output, status detail, and live output, pushes the terminal status onto `priorAttempts`, increments `attempt`, and returns the node to `idle` while retaining the activity log
- [x] 4.3 Default `attempt` to 1 when loading a run-state file written before this change
- [x] 4.4 Tests: reset clears results but retains activity; attempt counters persist and reload; a pre-change run-state file loads without error

## 5. Loop-back execution in the engine

- [x] 5.1 On terminal `error` in `runNode`, look for a loop-back edge whose source is the failing node before calling `markDownstreamSkipped`
- [x] 5.2 Compute the reset set as `{target} ∪ (descendants(target) ∩ ancestors(source)) ∪ {source}` over forward edges, and reset each node via `resetNode`
- [x] 5.3 Fire the loop only when the target's attempt count is below the edge's `maxAttempts`; otherwise leave the source in `error`, run `markDownstreamSkipped`, and set a detail naming the attempt limit
- [x] 5.4 Record the failing node's output and status detail as retry context, and inject it into the loop-back target's next `upstreamInputs` labelled as the reason for the retry
- [x] 5.5 Handle a rejected Approval-Gate as a loop-back source, so reject re-runs the segment when a loop-back is declared and skips downstream when it is not
- [x] 5.6 Verify `allTerminal()` still terminates: the reset happens synchronously inside the failure path before the scheduler re-evaluates
- [x] 5.7 Tests: a failing Validate resets and re-runs the segment; a subsequent pass continues downstream; nodes off the failure path keep their results; the attempt bound stops the loop and skips downstream; a run with loop-backs always terminates
- [x] 5.8 Test that the retried node's context contains the failure reason from the node that triggered the loop

## 6. Loop visualization in the terminal canvas

- [x] 6.1 Exclude loop-back edges from layer assignment in `computeLayout` (`src/ui/layout.ts`) so node positions are unchanged by their presence
- [x] 6.2 Render loop-back edges in a second pass in `renderGraph` (`src/ui/canvas.ts`), routed in a reserved row band below the boxes with a distinct glyph run and style
- [x] 6.3 Ensure overlapping loop-backs share the row band without colliding with forward elbows between the same nodes
- [x] 6.4 Render an attempt badge on any node whose `attempt` is greater than 1, and nothing on first-attempt nodes
- [x] 6.5 Indicate which loop-back fired and which node triggered it when a loop is active
- [x] 6.6 Show attempt history (count and prior terminal statuses) in the node detail view for re-run nodes only
- [x] 6.7 Tests: back edges render distinctly at the grid level; layout is identical with and without a loop-back; the attempt badge appears only after a re-run; reset nodes render as `idle` again

## 7. Documentation and end-to-end verification

- [x] 7.1 Document loop-back edges, `maxAttempts`, and its default in the workflow config section of `README.md`
- [x] 7.2 Decide the open question on whether the scaffolded default workflow ships a commented-out loop-back, and update `src/defaultWorkflow.ts` accordingly
- [x] 7.3 Add an end-to-end test using the real `Engine`: a workflow whose Validate fails once then passes reaches Git-ops, with the correct attempt counts recorded
- [x] 7.4 Add an end-to-end test that the same workflow with a permanently failing Validate stops at the attempt bound and never reaches Git-ops
- [x] 7.5 Run `npm run lint`, `npm run typecheck`, and `npm test` clean
