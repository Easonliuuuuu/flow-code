## 1. Staged validation in the loader

- [x] 1.1 Give `loadWorkflowFromString` a staged result: which check stage it reached (parse → file schema → declarations → structure) alongside the `problems` it collected, so a caller can distinguish a failed check from one that was never evaluated
- [x] 1.2 Carry the stage on `WorkflowValidationError` without changing its `problems` shape, so `loadWorkflowOrFail` and every existing caller keep working untouched
- [x] 1.3 Report the independent structural checks together, gating only where a check genuinely depends on an earlier one
- [x] 1.4 Unit-test that a YAML parse failure reports the structural checks as not evaluated, and that a file with an unknown node type, a bad config, and a dangling edge reports all three in one pass

## 2. `flow-code validate`

- [x] 2.1 Add `src/cli/validate.ts` calling the same `loadWorkflow` that `run` uses, formatting the staged result, and exiting non-zero on any failure
- [x] 2.2 Report a missing `.flow-code/workflow.yaml` as its own failure naming the path and pointing at `flow-code init`
- [x] 2.3 Register the command in `src/cli.ts` and add it to the help output
- [x] 2.4 Integration-test the three exits: valid file → 0 and no run document written, invalid file → non-zero listing every failure, missing file → non-zero naming the path
- [x] 2.5 Test that `validate` and the run path agree on accept/reject across a fixture table, pinning them to the same checks
- [x] 2.6 Add `validate` to the README CLI table

## 3. The run document records its graph

- [x] 3.1 Add a serializable `RecordedGraph` to `src/runstate/types.ts` — per node an id, node type id, validated config and budget; per edge from, to, loop-back and condition; plus run settings — and hang it off `RunState` as an optional field
- [x] 3.2 Split `buildWorkflow` out of `loadWorkflowFromString`, so a recorded graph rebuilds through the same checks a fresh load applies
- [x] 3.3 Write `recordGraph`: the projection from a loaded `Workflow`, holding no zod schema, function, or derived adjacency
- [x] 3.4 Write `rehydrateGraph`: re-resolve type ids against the registry, re-resolve skills from the reading machine's roots, re-derive adjacency and order
- [x] 3.5 Fail rehydration with `RecordedGraphError` when a recorded node names a type the registry no longer has, naming the node and the type
- [x] 3.6 Have `RunStateStore` accept a graph, seed the node map from it, and record it — before the first node can leave `idle`
- [x] 3.7 Record the graph from `cmdRun`, on both the fresh and resumed paths
- [x] 3.8 Round-trip test: project a graph with loop-backs, a per-node budget and a condition, serialize, rebuild, and assert nodes, config, budgets, edges, settings, order and ancestry all survive

## 4. Documentation and ledger

- [x] 4.1 Map the `validate` and `record` commit scopes to `workflow-graph` in `coverage.yaml`
- [x] 4.2 Record on GAP-02/GAP-05 that a `run-state` spec exists and is implemented, and that both close when this change archives — the ledger cannot map a capability `openspec/specs/` does not hold yet, and syncing the delta early would leave the archive re-applying it
- [x] 4.3 **At archive:** add `run-state` to `coverage.yaml` mapped to BR-04, owning the `runstate` module and scope, and close GAP-02 and GAP-05. Leave GAP-01 open — a spec for the run document is not a spec for the command that reads it
- [x] 4.4 Register `add-workflow-validation-and-recorded-graph` and `add-per-task-workflow-graphs` in `coverage.yaml`'s `changes:` map
- [x] 4.5 Capture in `docs/product/inbox.md`: whether "the process fits the task" deserves its own BR in M2, and whether a named graph may override the non-ceiling settings
- [x] 4.6 Run `npm run status` and confirm `npm run status:check` is green
- [x] 4.7 Full suite, lint, and typecheck green
