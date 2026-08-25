## 1. Accept a proposal on the reported path

- [x] 1.1 In `src/guest/validate.ts`, treat a Plan node's `done` report as a case needing more than shape validation: keep the existing output-shape check, and carry the proposal through on the accepted transition so the writer can act on it rather than re-parsing output
- [x] 1.2 In `src/guest/report.ts`, call `expandRecordedGraph(workflow, planNodeId, proposal, { repoRoot })` between validating the transition and persisting, so the rebuilt graph and the `done` node land in one write
- [x] 1.3 Persist the rebuilt `RecordedGraph` onto the run document's `graph`, and add the proposal's nodes to `state.nodes` as `idle`, so the new nodes exist for the next report
- [x] 1.4 Refuse the report as a `GuestReportError` when the build throws, with the build's own message; assert run-state is byte-identical afterwards so a refusal is provably inert
- [x] 1.5 Unit tests: a valid proposal expands; a proposal routing around the gate is refused (the 1.3-style dominance check); an unknown node type is refused; a proposal introducing a second Plan node is refused; a duplicate node id is refused

## 2. Keep both producers on one implementation

- [x] 2.1 Confirm `expandRecordedGraph` needs no signature change for this caller; if it does, change it once and update `cli/run.ts` in the same commit rather than adding a guest-only variant
- [x] 2.2 Test that engine and guest produce an identical `RecordedGraph` from the same starting workflow and the same proposal — the test that would fail first if the two paths ever diverge
- [x] 2.3 Test that a run's `enforcement` block (tier, surface, absent) is unchanged across an expansion

## 3. Tell the guest what the run now holds

- [x] 3.1 `flow-code node done` on a Plan node prints the run's node ids in graph order after expanding
- [x] 3.2 The MCP completion tool returns the same list in its result payload
- [x] 3.3 Test both surfaces return the same ids for the same expansion, extending the existing CLI/MCP equivalence coverage
- [x] 3.4 Test that reporting a node introduced by the proposal is accepted, where before expansion it was rejected as an unknown node id

## 4. Brief the expansion

- [x] 4.1 In `src/guest/instructions.ts`, give a Plan node's section the expansion step: its output is a proposed graph, completing it replaces its successors, and the run is the authority on what may be reported next
- [x] 4.2 Emit nothing about expansion when the workflow has no Plan node
- [x] 4.3 Test both branches, and that the drift detection `connect --check` performs still reports the generated section as current after this change

## 5. Viewer and docs

- [x] 5.1 Confirm `WorkflowHost` redraws a guest-driven expansion with no change: it re-derives from `RunState.graph` on shape change and is documented as independent of `watch`, so this should already hold — a test, not new code, unless it does not
- [x] 5.2 `docs/agent-integration.md`: describe expansion in the reported flow, and state plainly that expanding does not change what a tier enforces
- [x] 5.3 Update `docs/node-types.md` generation if the Plan node's description needs to stop implying the splice is engine-only (regenerate via `npm run docs:node-types`, do not hand-edit)

## 6. Prove it against a real session

- [ ] 6.1 Scaffold the `planned` preset in a testbed, `connect`, and walk it from a real Claude Code session: propose a graph, watch the viewer grow, report the proposed nodes, reach the gate
- [ ] 6.2 Repeat with a proposal that routes around the gate, and confirm the refusal reaches the agent as an error it can act on rather than a silent no-op
- [ ] 6.3 Record the run and check `flow-code reconcile` still reports honestly against an expanded graph

Section 6 is unrun: it walks a real Claude Code session against a testbed, which
costs live API usage and has to be driven by the user rather than from a tool
call. Everything it would exercise is covered by tests
(`test/guest.expand.test.ts`, `test/guest.mcp.test.ts`, `test/cli.node.test.ts`,
`test/ui.workflowHost.test.ts`) except the one thing only a session can show:
whether an agent reading the generated brief actually proposes a graph that
builds on the first attempt.
