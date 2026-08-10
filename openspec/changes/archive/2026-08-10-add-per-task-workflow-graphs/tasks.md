## 1. Settle how the UI receives its workflow

- [x] 1.1 Decide between a swappable `runUi` workflow and deferring `watch`'s mount, and record the decision and its rejected alternative in `design.md`
- [x] 1.2 Implement the chosen shape, leaving the `run` path passing its in-memory `Workflow` exactly as it does today
- [x] 1.3 Test that a viewer open before any run exists still shows something honest, and that attaching to a run shows the run's own shape

## 2. Readers use the recorded graph

- [x] 2.1 Render `watch` from the run document's recorded graph, rehydrated via `rehydrateGraph`
- [x] 2.2 Remove `reconcileRunState` and stop `src/cli/watch.ts` loading `workflow.yaml` for node ids
- [x] 2.3 Report "shape unavailable" for a run document carrying no recorded graph, with no fallback to the workflow file
- [x] 2.4 Report a `RecordedGraphError` (a node type this build no longer has) as its own state rather than as an empty graph
- [x] 2.5 Test that editing `workflow.yaml` mid-run leaves both the recorded graph and what a watcher renders unchanged
- [x] 2.6 Test that a watcher renders a run whose `workflow.yaml` has been deleted outright

## 3. Resume executes what was recorded

- [x] 3.1 Make `--resume` rehydrate the recorded graph rather than reloading the file
- [x] 3.2 State on resume that it is continuing the recorded graph, so a diverged file is visible
- [x] 3.3 Decide what `resolveResumeState` should do when the recorded graph cannot be rebuilt, and implement it
- [x] 3.4 Test resume after the workflow file has diverged: the recorded graph runs, and completed node state stays attributed to the nodes that produced it

## 4. Mid-run edits update both

- [x] 4.1 Move the `write.ts` setters behind one edit path that updates the recorded graph and the file together, so no call site can update one alone
- [x] 4.2 Reject an edit naming a node id absent from the recorded graph, with the node id in the error
- [x] 4.3 Point the TUI's model, skills, budget, and test-command edits at the new path
- [x] 4.4 Test that changing a node's model mid-run is visible to a watcher without the workflow file being reloaded

## 5. Named graphs in the workflow file

- [x] 5.1 Extend `workflowFileSchema` to a union: today's top-level `nodes`/`edges`, or a `graphs:` map of named entries each with a description, nodes, and edges
- [x] 5.2 Reject a file declaring both forms, rather than resolving it by precedence
- [x] 5.3 Validate every named graph independently and in full, attributing each failure to the graph it came from
- [x] 5.4 Keep `settings` declared once at the top level; reject a `budget` inside a named graph, naming the graph and pointing at `node.budget`
- [x] 5.5 Extend `flow-code validate` to report per-graph failures
- [x] 5.6 Test that an existing single-graph file loads and runs exactly as before

## 6. Selecting a graph at run start

- [x] 6.1 Resolve the graph name in `run` before any node starts: explicit name if given, otherwise the `selectFromList` picker showing each name with its description
- [x] 6.2 Fail before execution when no TTY and no name is given, listing the declared names
- [x] 6.3 Fail before execution when a requested name is not declared, listing the names that are
- [x] 6.4 Skip the question entirely for a single-graph file
- [x] 6.5 Pass the selected name to `recordGraph`, so the run document carries it
- [x] 6.6 Show the selected name in the run header, and in `watch`'s header for a run it attached to
- [x] 6.7 Integration-test the four paths: single-graph (no prompt), named + explicit, named + interactive, named + no TTY and no name

## 7. Documentation and ledger

- [x] 7.1 Document the named-graph form in `docs/workflow-reference.md`, including that `settings` is declared once and why a graph cannot carry a budget
- [x] 7.2 Document graph selection in the README, and check whether `flow-code runs` should show the selected name
- [x] 7.3 Decide whether GAP-01 closes here; update `coverage.yaml` either way
- [x] 7.4 Run `npm run status` and confirm `npm run status:check` is green
