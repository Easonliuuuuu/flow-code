## 0. Prerequisites

- [ ] 0.1 Close the spec gap for `flow-code watch` — write its `terminal-canvas-ui` requirements (read-only viewer, run attachment, driver liveness), since this change's UI delta builds on them
- [ ] 0.2 Settle the open questions in `design.md`: how enforcement is verified before a run claims a tier, run identity per guest session, which node types reconciliation expects to touch the tree, and the CLI verb shape
- [ ] 0.3 Re-confirm the host's hook contract against the version being targeted — the deny decision, its reason field, the turn-end hook, and the delegation hook — and record which host version the enforcement layer was written against

## 1. Enforcement tiers and run-state ownership

- [ ] 1.1 Add tier and provenance fields to `RunState`: which tier the run ran under, the reporting surface used, and the guarantees that tier does not provide
- [ ] 1.2 Record a tier downgrade with the point it happened, so a run that lost enforcement mid-way is not presented at its opening tier
- [x] 1.3 Make ownership explicit in `RunStateStore` — a run records its owner, and a writer that does not own it is refused rather than silently accepted *(delivered by `add-run-state-ownership`: "One writer owns a run document" in the `run-state` spec now requires the writer to verify ownership before each write, and "Ownership transfers explicitly" covers the resume handover this change's guest writer inherits)*
- [ ] 1.4 Add a guest-side writer that opens a run, applies one validated transition, and persists, without assuming it is the only process alive
- [ ] 1.5 Test that a guest write against a run owned by a live engine process is refused and leaves the document byte-identical
- [ ] 1.6 Test that an engine-driven run records the engine tier with no absent guarantees, and is otherwise byte-identical to what it was before this change

## 2. Transition validation

- [ ] 2.1 Build a validator over `workflow/graph.ts` that accepts or rejects a reported transition against current run-state, returning a reason on rejection
- [ ] 2.2 Reject: unknown node id, start before upstream is `done`, completion of a node that never started
- [ ] 2.3 Validate reported completion output against the node type's declared output shape, naming offending fields on failure
- [ ] 2.4 Test each rejection case leaves run-state unchanged

## 3. Host-session harness

- [ ] 3.1 Add the enforcement entry point that resolves the run's current node from run-state and compiles its policy through `harness/compile.ts`, with no second policy definition
- [ ] 3.2 Deny tool calls outside the current node's capability set, returning the same reason an engine-driven denial returns
- [ ] 3.3 Run Bash invocations through `harness/gitCommands.ts` and refuse repository-mutating git while an upstream gate is undecided or rejected
- [ ] 3.4 Record host-session denials in run-state's activity log in the same shape engine-driven denials use
- [ ] 3.5 Fail closed: an enforcement layer that errors, times out, or cannot read run-state denies the call, and reports the failure distinctly from a capability denial
- [ ] 3.6 Test the envelope moves with the run — a call permitted under one node is denied after the run advances to a node without that capability, with no session restart
- [ ] 3.7 Test the same workflow under `flow-code run` and under an instrumented host session compiles an identical policy per node
- [ ] 3.8 Test read-only git is unaffected while a gate is `waiting`

## 4. Node delegation

- [ ] 4.1 Deliver each node's role prompt to the host session as a delegated unit of work, so a node runs with fresh context rather than sharing the session's
- [ ] 4.2 Apply the delegating node's capability set to delegated tool calls
- [ ] 4.3 Attribute delegated activity to the delegating node in run-state
- [ ] 4.4 Test a delegated tool call outside the node's capability set is denied identically to the same call made directly

## 5. Gate decisions in a host session

- [ ] 5.1 Request gate decisions through a surface that requires the user to answer directly and that a host-side auto-responder cannot satisfy silently
- [ ] 5.2 Refuse to record an approval produced by an automated response, reporting why
- [ ] 5.3 Record which surface produced every gate decision
- [ ] 5.4 Test that a gate left undecided keeps git writes denied, and that approving it releases them

## 6. Packaging and installation

- [ ] 6.1 Package the reporting tools, the instructions, and the enforcement layer as one installable unit for hosts that support packaged extensions
- [ ] 6.2 On hosts that support only part of the surface, install what is supported and report what is not, stating the enforcement consequence
- [ ] 6.3 Verify enforcement is actually active before a run records a tier claiming it, and record the lower tier when verification fails
- [ ] 6.4 Test that installation names every file it changed and leaves unrelated configuration byte-identical
- [ ] 6.5 Test that a run opened with the enforcement layer disabled records the self-reported tier and says so

## 7. Reporting surfaces

- [ ] 7.1 Add the MCP tools for opening a run, starting, completing, and failing a node, and closing a run, confined to a boundary module so validation and writing stay independently testable
- [ ] 7.2 Add the equivalent `flow-code node …` CLI subcommands for hosts without MCP, through the same validator and writer, exiting non-zero with the rejection reason
- [ ] 7.3 Return rejections as errors an agent can act on
- [ ] 7.4 Test an identical transition sequence over MCP and over the CLI produces equivalent run-state apart from run id, timestamps, and recorded surface
- [ ] 7.5 Test a full workflow driven end to end over the CLI, and confirm `flow-code watch` renders it

## 8. Agent instructions

- [ ] 8.1 Generate instructions from `.flow-code/workflow.yaml`: node order, each node's purpose, its output contract, and how to report transitions
- [ ] 8.2 Describe loop-back edges explicitly, since no engine will route them for a guest
- [ ] 8.3 Install into the host agent's instruction locations idempotently, replacing only a delimited section and leaving unrelated content untouched
- [ ] 8.4 Detect and report instructions that no longer match the current workflow, and report the never-installed case distinctly

## 9. Reconciliation

- [ ] 9.1 Compare claimed node state against the tree using the run's recorded baseline, reporting nodes whose claims are unsupported
- [ ] 9.2 Exempt node types not expected to modify the repository, and report a missing baseline as unreconcilable rather than returning a false result
- [ ] 9.3 Test that reconciliation leaves the run-state document byte-identical

## 10. Viewer disclosure

- [ ] 10.1 Indicate the run's enforcement tier in the viewer, driven by run-state rather than inferred from the data's shape
- [ ] 10.2 Present unavailable token totals and capability indicators as unavailable rather than as zero
- [ ] 10.3 Report a run whose tier changed mid-run at its weakest recorded tier
- [ ] 10.4 Surface reconciliation findings in the viewer, naming the affected nodes
- [ ] 10.5 Test that an engine-driven run renders exactly as it did before this change

## 11. Documentation

- [ ] 11.1 Document the three enforcement tiers in the README: what each provides, what it does not, and which hosts reach which tier
- [ ] 11.2 Document installation per supported host, and what a host that cannot run the enforcement layer gets instead
- [ ] 11.3 State plainly that loop-backs under a host session are steering rather than routing, and that reconciliation is the check on whether it worked
