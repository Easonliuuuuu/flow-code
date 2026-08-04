## 0. Prerequisites

- [ ] 0.1 Close the spec gap for `flow-code watch` — write its `terminal-canvas-ui` requirements (read-only viewer, run attachment, driver liveness), since this change's UI delta builds on them
- [ ] 0.2 Settle the open questions in `design.md`: run identity per guest session, which node types reconciliation expects to touch the tree, the CLI verb shape, and how much sandboxing is recoverable for a guest process

## 1. Run-state ownership and provenance

- [ ] 1.1 Add provenance fields to `RunState`: whether the run is guest-driven, the reporting surface used, and which guarantees did not apply
- [ ] 1.2 Make ownership explicit in `RunStateStore` — a run records its owner, and a writer that does not own it is refused rather than silently accepted
- [ ] 1.3 Add a guest-side writer that opens a run, applies one validated transition, and persists, without assuming it is the only process alive
- [ ] 1.4 Test that a guest write against a run owned by a live engine process is refused and leaves the document byte-identical

## 2. Transition validation

- [ ] 2.1 Build a validator over `workflow/graph.ts` that accepts or rejects a reported transition against current run-state, returning a reason on rejection
- [ ] 2.2 Reject: unknown node id, start before upstream is `done`, completion of a node that never started
- [ ] 2.3 Validate reported completion output against the node type's declared output shape, naming offending fields on failure
- [ ] 2.4 Test each rejection case leaves run-state unchanged

## 3. CLI reporting surface

- [ ] 3.1 Add the `flow-code node …` subcommands for opening a run, starting, completing, and failing a node, and closing a run
- [ ] 3.2 Wire them through the shared validator and writer, exiting non-zero with the rejection reason on failure
- [ ] 3.3 Test a full workflow driven end to end over the CLI, and confirm `flow-code watch` renders it

## 4. MCP reporting surface

- [ ] 4.1 Add the MCP server entry point, confined to a boundary module so the validation and writing logic stays independently testable
- [ ] 4.2 Expose the same operations as tools, returning rejections as errors an agent can act on
- [ ] 4.3 Test that an identical transition sequence over MCP and over the CLI produces equivalent run-state apart from run id, timestamps, and recorded surface

## 5. Agent instructions

- [ ] 5.1 Generate instructions from `.flow-code/workflow.yaml`: node order, each node's purpose, its output contract, and how to report transitions
- [ ] 5.2 Describe loop-back edges explicitly, since no engine will route them for a guest
- [ ] 5.3 Install into the host agent's instruction locations idempotently, replacing only a delimited section and leaving unrelated content untouched
- [ ] 5.4 Detect and report instructions that no longer match the current workflow, and report the never-installed case distinctly

## 6. Reconciliation

- [ ] 6.1 Compare claimed node state against the tree using the run's recorded baseline, reporting nodes whose claims are unsupported
- [ ] 6.2 Exempt node types not expected to modify the repository, and report a missing baseline as unreconcilable rather than returning a false result
- [ ] 6.3 Test that reconciliation leaves the run-state document byte-identical

## 7. Viewer disclosure

- [ ] 7.1 Indicate a guest-driven run distinctly in the viewer, driven by run-state provenance rather than inferred from the data's shape
- [ ] 7.2 Present unavailable token totals and capability indicators as unavailable rather than as zero
- [ ] 7.3 Surface reconciliation findings in the viewer, naming the affected nodes
- [ ] 7.4 Test that an engine-driven run renders exactly as it did before guest mode existed

## 8. Documentation

- [ ] 8.1 Document guest mode in the README beside the existing watch section: what it buys, what it does not enforce, and how it differs from `flow-code run`
- [ ] 8.2 Document the registration step for each supported host agent
