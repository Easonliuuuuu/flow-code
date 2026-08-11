> **Sequenced in three parts, two of them delivered.**
>
> - **Reporting** (`guest-run-reporting`, `guest-agent-instructions`) — an outside agent
>   walks the graph, every transition is validated against it, and the run is labelled
>   wherever it is shown.
> - **Enforcement** (`host-session-harness`) — a `PreToolUse` hook applies the run's current
>   node's capability set to the host session, using the same policy function the engine
>   uses. It was held back from the first part deliberately: its risk is a hook contract
>   flow-code does not own, and it is strictly downstream of the writer, since a policy is
>   compiled from the run's *current node* and only a writer advances that.
> - **Reconciliation** (`run-state-reconciliation`, section 9 and 10.4) — still to come.
>   Independent of the other two, and unblocked now that reported runs record a baseline.

## 0. Prerequisites

- [x] 0.1 Close the spec gap for `flow-code watch` — write its `terminal-canvas-ui` requirements (read-only viewer, run attachment, driver liveness), since this change's UI delta builds on them *(residual written as `terminal-canvas-ui` requirements in this change's delta — the run-document half (attach with no id, liveness, read-only readers) was closed by `add-run-state-ownership`; what is left is the command's own surface)*
- [ ] 0.2 Settle the open questions in `design.md`: how enforcement is verified before a run claims a tier, run identity per guest session, which node types reconciliation expects to touch the tree, and the CLI verb shape *(all settled but one: the CLI verb shape is `flow-code node <id> start|done|fail`; a guest run opens fresh each time and surfaces target the newest open non-engine run; enforcement is verified by a heartbeat the hook itself writes, re-checked on every transition, because `open_run` is a tool call the hook fires for first. Still open: which node types reconciliation expects to touch the tree — it belongs to the change that needs it)*
- [x] 0.3 Re-confirm the host's hook contract against the version being targeted — the deny decision, its reason field, the turn-end hook, and the delegation hook — and record which host version the enforcement layer was written against *(the hook contract was re-confirmed against Claude Code as of August 2026 and recorded in design.md)*

## 1. Enforcement tiers and run-state ownership

- [x] 1.1 Add tier and provenance fields to `RunState`: which tier the run ran under, the reporting surface used, and the guarantees that tier does not provide
- [x] 1.2 Record a tier downgrade with the point it happened, so a run that lost enforcement mid-way is not presented at its opening tier
- [x] 1.3 Make ownership explicit in `RunStateStore` — a run records its owner, and a writer that does not own it is refused rather than silently accepted *(delivered by `add-run-state-ownership`: "One writer owns a run document" in the `run-state` spec now requires the writer to verify ownership before each write, and "Ownership transfers explicitly" covers the resume handover this change's guest writer inherits)*
- [x] 1.4 Add a guest-side writer that opens a run, applies one validated transition, and persists, without assuming it is the only process alive
- [x] 1.5 Test that a guest write against a run owned by a live engine process is refused and leaves the document byte-identical
- [x] 1.6 Test that an engine-driven run records the engine tier with no absent guarantees, and is otherwise byte-identical to what it was before this change

## 2. Transition validation

- [x] 2.1 Build a validator over `workflow/graph.ts` that accepts or rejects a reported transition against current run-state, returning a reason on rejection
- [x] 2.2 Reject: unknown node id, start before upstream is `done`, completion of a node that never started
- [x] 2.3 Validate reported completion output against the node type's declared output shape, naming offending fields on failure
- [x] 2.4 Test each rejection case leaves run-state unchanged

## 3. Host-session harness

- [x] 3.1 Add the enforcement entry point that resolves the run's current node from run-state and compiles its policy through `harness/compile.ts`, with no second policy definition *(decideCall extracted from the engine's interceptor; both callers share it)*
- [x] 3.2 Deny tool calls outside the current node's capability set, returning the same reason an engine-driven denial returns
- [x] 3.3 Run Bash invocations through `harness/gitCommands.ts` and refuse repository-mutating git while an upstream gate is undecided or rejected
- [x] 3.4 Record host-session denials in run-state's activity log in the same shape engine-driven denials use *(denials only — the cost of logging every allowed call is recorded in enforce.ts)*
- [x] 3.5 Fail closed: an enforcement layer that errors, times out, or cannot read run-state denies the call, and reports the failure distinctly from a capability denial
- [x] 3.6 Test the envelope moves with the run — a call permitted under one node is denied after the run advances to a node without that capability, with no session restart
- [x] 3.7 Test the same workflow under `flow-code run` and under an instrumented host session compiles an identical policy per node
- [x] 3.8 Test read-only git is unaffected while a gate is `waiting`

## 4. Node delegation

- [x] 4.1 Deliver each node's role prompt to the host session as a delegated unit of work, so a node runs with fresh context rather than sharing the session's *(start_node returns the node's brief, and node_brief re-reads it)*
- [x] 4.2 Apply the delegating node's capability set to delegated tool calls
- [x] 4.3 Attribute delegated activity to the delegating node in run-state
- [x] 4.4 Test a delegated tool call outside the node's capability set is denied identically to the same call made directly

## 5. Gate decisions in a host session

- [x] 5.1 Request gate decisions through a surface that requires the user to answer directly and that a host-side auto-responder cannot satisfy silently
- [x] 5.2 Refuse to record an approval produced by an automated response, reporting why
- [x] 5.3 Record which surface produced every gate decision
- [x] 5.4 Test that a gate left undecided keeps git writes denied, and that approving it releases them

## 6. Packaging and installation

- [x] 6.1 Package the reporting tools, the instructions, and the enforcement layer as one installable unit for hosts that support packaged extensions *(`flow-code connect` for any host, plus a Claude Code plugin that needs no per-project step)*
- [x] 6.2 On hosts that support only part of the surface, install what is supported and report what is not, stating the enforcement consequence
- [x] 6.3 Verify enforcement is actually active before a run records a tier claiming it, and record the lower tier when verification fails
- [x] 6.4 Test that installation names every file it changed and leaves unrelated configuration byte-identical
- [x] 6.5 Test that a run opened with the enforcement layer disabled records the self-reported tier and says so

## 7. Reporting surfaces

- [x] 7.1 Add the MCP tools for opening a run, starting, completing, and failing a node, and closing a run, confined to a boundary module so validation and writing stay independently testable
- [x] 7.2 Add the equivalent `flow-code node …` CLI subcommands for hosts without MCP, through the same validator and writer, exiting non-zero with the rejection reason
- [x] 7.3 Return rejections as errors an agent can act on
- [x] 7.4 Test an identical transition sequence over MCP and over the CLI produces equivalent run-state apart from run id, timestamps, and recorded surface
- [x] 7.5 Test a full workflow driven end to end over the CLI, and confirm `flow-code watch` renders it

## 8. Agent instructions

- [x] 8.1 Generate instructions from `.flow-code/workflow.yaml`: node order, each node's purpose, its output contract, and how to report transitions
- [x] 8.2 Describe loop-back edges explicitly, since no engine will route them for a guest
- [x] 8.3 Install into the host agent's instruction locations idempotently, replacing only a delimited section and leaving unrelated content untouched
- [x] 8.4 Detect and report instructions that no longer match the current workflow, and report the never-installed case distinctly

## 9. Reconciliation

- [ ] 9.1 Compare claimed node state against the tree using the run's recorded baseline, reporting nodes whose claims are unsupported *(deferred with reconciliation)*
- [ ] 9.2 Exempt node types not expected to modify the repository, and report a missing baseline as unreconcilable rather than returning a false result *(deferred with reconciliation)*
- [ ] 9.3 Test that reconciliation leaves the run-state document byte-identical *(deferred with reconciliation)*

## 10. Viewer disclosure

- [x] 10.1 Indicate the run's enforcement tier in the viewer, driven by run-state rather than inferred from the data's shape
- [x] 10.2 Present unavailable token totals and capability indicators as unavailable rather than as zero
- [x] 10.3 Report a run whose tier changed mid-run at its weakest recorded tier
- [ ] 10.4 Surface reconciliation findings in the viewer, naming the affected nodes *(deferred with reconciliation)*
- [x] 10.5 Test that an engine-driven run renders exactly as it did before this change

## 11. Documentation

- [x] 11.1 Document the three enforcement tiers in the README: what each provides, what it does not, and which hosts reach which tier
- [x] 11.2 Document installation per supported host, and what a host that cannot run the enforcement layer gets instead
- [x] 11.3 State plainly that loop-backs under a host session are steering rather than routing, and that reconciliation is the check on whether it worked
