## 1. Record the decision and its evidence

- [x] 1.1 Add optional `diffs: Array<{ label?: string; diff: string }>` to `approvalGateOutput` in `src/registry/index.ts`, matching `ApprovalRequest['diffs']` in `src/engine/types.ts`. Keep it optional — the guest path records a decision with no diffs.
- [x] 1.2 Truncate the diffs in `src/executors/gate.ts` before attaching them to the result, so a large diff cannot consume the shared `UPSTREAM_OUTPUT_LIMIT` budget that `Engine.upstreamInputs` divides across every upstream output.
- [x] 1.3 Change the reject branch of `executeApprovalGate` to yield `status: 'done'` with detail `rejected by user`, leaving the recorded output at `decision: 'rejected'`. Do **not** add `failsWhen` for the rejected verdict — `Engine.outputFailureDetail` would force the node back to `error`.
- [x] 1.4 Update the executor's doc comment in `src/executors/gate.ts`, which currently states that reject sets the gate to `error` and the engine skips everything downstream.
- [x] 1.5 Update `outputSummary` on the `approval-gate` type definition, then regenerate `docs/node-types.md` with `scripts/gen-node-types-doc.mjs` and confirm `npm run docs:check` passes. Note this string also feeds the generated guest instructions.
- [x] 1.6 Add a test that a decided gate's `diffs` survive schema validation into the run state — the behaviour `src/ui/App.tsx` already assumes but never gets today.

## 2. Route the rejection safely

- [x] 2.1 In `buildWorkflow` (`src/workflow/load.ts`), derive an effective edge list after nodes are built with resolved types and before `new Graph(...)`: every non-loop-back edge whose `from` resolves to an `approval-gate` node and which carries no `when:` gains `when: "<from>.decision == 'approved'"`. Leave explicit conditions and loop-back edges untouched.
- [x] 2.2 Pass the derived list to both `new Graph(...)` and the returned `Workflow.edges`, and confirm it flows through the structural condition validation that follows, rather than around it.
- [x] 2.3 Add tests: an unconditional gate edge gains the condition; an explicitly conditioned gate edge is unchanged; a non-gate unconditional edge is unchanged; a loop-back out of a gate gains nothing.
- [x] 2.4 Update `test/nodes.test.ts` — the gate now reaches `done` with `decision: 'rejected'`, and its downstream node is still `skipped` but with skip reason `condition` rather than `upstream`. Assert the skip reason explicitly; this is the change's most likely silent breakage.
- [x] 2.5 Update `test/e2e.test.ts`, keeping the "a rejected run leaves exactly one commit" assertion verbatim. That assertion is the guarantee this task group exists to preserve.
- [x] 2.6 Update any graph-shape assertions in `test/workflow.test.ts` and `test/presets.test.ts` that now observe a synthesized condition on a gate's out-edge.

## 3. Keep the loop-back working

- [x] 3.1 Widen the loop-back trigger in `Engine.executeNode` so a gate whose recorded decision is `rejected` is also considered a loop-back source, while `markDownstreamSkipped` stays on the `error` path alone.
- [x] 3.2 Update the rejected-gate loop-back test in `test/engine.test.ts`: the fake gate executor now yields `done`, and the segment must still re-run.
- [x] 3.3 Add a test that a rejected gate with no loop-back and no rejection branch skips its approval-branch downstream without firing a loop-back.

## 3b. Let a completed step send the work back

- [x] 3b.1 Add `on: failure | success` to the loop-back schema, defaulting to `failure`, and carry it onto `Graph`'s `Loopback`. Normalize `loopback: true` by preprocessing rather than a union, so a bad field is reported against that field instead of as a bare "Invalid input".
- [x] 3b.2 Filter `fireLoopback` by trigger, and call it for a completed node as well as a failed one — a rejected gate counts as `failure`. Without this a revision step completes and the run simply ends.
- [x] 3b.3 On firing a loop-back, return every `condition`-skipped node below the target to `idle` via a new `clearSkip` (not `resetNode`, which would count an attempt against a node that never ran). Otherwise the first pass's routing verdict outlives the inputs it was made from and the retry has nowhere to deliver its work.
- [x] 3b.4 Test the trigger: explicit `on`, the default, an invalid value naming the edge, and that a success-triggered path ignores a failed source.
- [x] 3b.5 Test the full route in `test/routing.test.ts`: rejection runs the revision step, loops back, and ships on the second decision; approval never runs it; the attempt bound stops it revising forever.
- [x] 3b.6 Test in `test/e2e.test.ts` that the exact snippet the docs give loads against the scaffolded graph and drives a real commit, so the comment cannot drift from what works.

## 4. Tell a re-entered conversation why it is running

- [x] 4.1 In `src/executors/discuss.ts`, deliver `upstreamPreamble(ctx.upstream)` into the resumed session as a fresh turn when the node is resuming *and* carries upstream context, before waiting on the user. Distinguish the interrupted-conversation case (no retry reason) from the loop-back case.
- [x] 4.2 Widen the `discuss` role prompt in `src/registry/index.ts` so it does not assert the node runs at the start of a workflow.
- [x] 4.3 Add a test that a `discuss` node reset by a loop-back receives the retry reason in its resumed session, and that an interrupted-then-resumed conversation still gets no re-sent opening prompt.
- [x] 4.4 Add a test covering a second loop-back into the same node — the attempt-2 case where the transcript and session survive `resetNode` and the context would otherwise be a stale copy of attempt 1.

## 5. Keep a rejection visible

- [x] 5.1 Make `runExitCode` in `src/cli/run.ts` treat a gate with a recorded `rejected` decision as a failed run, so a rejected run still exits non-zero.
- [x] 5.2 Make `attention()` in `src/cli/status.ts` raise for a rejected gate, and check the headline and focus-node paths in the same file still name it.
- [x] 5.3 Make a rejected-but-`done` gate render distinctly from an approved one in `src/ui/nodeCard.ts` and `src/ui/canvas.ts`, which today colour on `status === 'error'` alone; check the status glyph in the gate's detail panel too.
- [x] 5.4 Update the affected expectations in `test/cli.status.test.ts` and `test/app.approvalGate.test.ts`, where a rejected gate now reaches the decided-gate diff-replay path.

## 6. Hold the guest boundary

- [x] 6.1 Leave `validateGate` in `src/guest/validate.ts` recording `error` on rejection, so guest runs are behaviourally unchanged.
- [x] 6.2 Harden `upstreamSatisfied` in the same file to treat an Approval-Gate dependency whose recorded decision is not `approved` as unsatisfied, mirroring the check `src/guest/enforce.ts` already uses for git-write blocking.
- [x] 6.3 Confirm the existing gate tests in `test/guest.enforce.test.ts` still pass unchanged, and add one asserting a downstream node stays unstartable after a rejection even if the gate's status is read as satisfied.

## 7. Document the branch without enabling it

- [x] 7.1 Replace the "a rejected approval gate deliberately has no loop-back" comment block in `src/defaultWorkflow.ts` with a commented-out revise branch, noting that each rejection opens an agent session and that `spec` stays outside the loop so acceptance criteria are not rewritten under `validate`.
- [x] 7.2 Update the matching passage in `docs/workflow-reference.md`, and the example graph in `README.md` if it shows the gate's out-edge.
- [x] 7.3 Leave both presets unchanged, and confirm the preset tests still assert a gate with no loop-back.

## 8. Verify

- [x] 8.1 Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run docs:check`.
- [ ] 8.2 Generate a `clean` testbed, scaffold a workflow, add the revise branch, and run to the gate. Reject: the revision conversation opens carrying the diff, the approval branch renders skipped rather than errored, and the gate does not read as a success.
- [ ] 8.3 Finish the conversation and confirm `implement` re-runs with the conclusion in its context, then reject a **second** time — the attempt-2 case, where the conversation must acknowledge the new diff rather than resuming the old thread blind.
- [ ] 8.4 Confirm a rejected run still exits non-zero, and that a `guest` testbed rejection still stops the run.
