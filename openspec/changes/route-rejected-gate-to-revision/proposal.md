## Why

An Approval-Gate rejection is currently a dead end: it sets the gate to `error`, cascade-skips every downstream node, and ends the run carrying no reason beyond "rejected by user". The graph already has a mechanism for turning a failure into another iteration — a loop-back that feeds the failure back as context — but a rejection has nothing useful to feed it. `recordRetryReason` exists precisely because "the re-run is identical to the run that just failed, and the loop is pure cost"; a bare rejection is exactly that case.

The result is an asymmetry the workflow does not otherwise have: the machine reviewer (`review`) gets to explain itself and route back for another pass, while the human reviewer gets a binary and a stop. This change gives the human the same expressive power, by letting a rejection route into a conversation whose distilled conclusion becomes the retry context.

## What Changes

- **BREAKING (behavioral):** a rejected Approval-Gate terminates as `done` with `decision: 'rejected'` rather than as `error`. A gate that got its answer completed; "the user said no" is a result, not a failure. Downstream halting moves from the error cascade onto conditional edges.
- Unconditional non-loop-back edges out of an Approval-Gate gain a synthesized `when: "<gate>.decision == 'approved'"` at load time. Existing workflow files are unchanged on disk and keep their current behavior — without this, step one alone would let a rejected change reach `git-ops` and be committed.
- The Approval-Gate output schema gains an optional `diffs` field. The executor already attaches diffs but Zod strips them before they reach the run state, so the recorded decision currently carries no evidence and the detail panel's post-decision diff replay never renders.
- A `discuss` node re-entered by a loop-back is told why. Today `resetNode` preserves the transcript and session id, so the node resumes and silently skips the branch holding its only upstream-context injection — the retry reason is recorded and never spoken.
- A loop-back edge gains an optional `on: failure | success`, defaulting to `failure`. Every existing loop-back is unchanged. `on: success` exists for the one shape where finishing *is* the signal to return: a revision step reached because work was rejected, whose conclusion is the reason to retry — a return path waiting for it to fail would wait forever.
- When a loop-back fires, a branch that was skipped because a routing condition sent the run elsewhere returns to `idle`. The segment being re-run is what decided that routing, so the skip no longer stands; without this the retry would redo the work and have nowhere to deliver it.
- The existing "loop-back declared on a rejected gate re-runs the segment" behavior is preserved, with its trigger widened so it survives the terminal-status change.
- A rejected run stays visibly rejected: non-zero exit code, a status-line attention token, and a node card that does not render as a clean success.
- The revise branch ships documented and commented-out in the scaffolded workflow and the workflow reference. Presets are unchanged.

Out of scope for this change: guest-mode support for the revise branch. Guest reporting keeps writing `error` on rejection, so guest runs behave exactly as they do today.

## Capabilities

### New Capabilities

None. The revision conversation is a second instance of the existing `discuss` node type — the graph already permits repeated types, and `discuss` already produces a conclusion shaped for a downstream implementation step to consume without the transcript.

### Modified Capabilities

- `approval-gate`: the terminal status of a rejection changes from `error` to `done` with a recorded `rejected` decision; the recorded output gains the diff that was decided on.
- `agent-execution`: the downstream-of-rejected-gate rule moves from the error cascade to conditional-edge evaluation; the loop-back-after-rejection requirement keeps its behavior but changes its trigger; a `discuss` node re-entered by a loop-back must receive its upstream context.
- `workflow-graph`: unconditional edges out of an Approval-Gate carry a synthesized approved-condition; the "no loop-back on a gate" statement is replaced by the routing options a rejection now has.
- `terminal-canvas-ui`: a rejected gate is `done` rather than `error`, so the styling rule that distinguishes it can no longer key on status alone.

## Impact

**Engine and workflow loading** — `src/executors/gate.ts` (terminal status, diffs into output), `src/workflow/load.ts` (condition synthesis in `buildWorkflow`, ahead of structural condition validation), `src/engine/engine.ts` (loop-back trigger), `src/registry/index.ts` (output schema, output summary, `discuss` role prompt), `src/executors/discuss.ts` (preamble delivery on a loop-back resume).

**User-visible surfaces** — `src/cli/run.ts` (exit code), `src/cli/status.ts` (attention token), `src/ui/nodeCard.ts` and `src/ui/canvas.ts` (a rejected-but-`done` gate must not read as success).

**Guest boundary** — `src/guest/validate.ts` only, to make "reject stops the run" rest on the recorded decision rather than on a status whose meaning is changing on the engine side. This mirrors the check `src/guest/enforce.ts` already uses for git-write blocking.

**Docs** — `src/defaultWorkflow.ts` and `docs/workflow-reference.md` (the documented revise branch), plus a regeneration of the generated `docs/node-types.md`.

**Tests** — the gate rejection tests in `test/nodes.test.ts`, `test/e2e.test.ts`, and `test/engine.test.ts` encode the current terminal status directly; `test/workflow.test.ts` and `test/presets.test.ts` assert graph shape that now carries a synthesized condition.

**Sequencing** — `openspec/changes/add-mcp-driver-connector/` also modifies `approval-gate`, but only the approve path and its interaction surfaces. No semantic conflict; the two need ordering at archive time.
