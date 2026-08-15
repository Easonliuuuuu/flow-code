## Context

The engine already has every mechanism this change needs, wired to the wrong places.

Conditional edges route (`src/workflow/condition.ts`, `Engine.unmetCondition`), loop-backs return with a recorded reason (`Engine.fireLoopback`, `Engine.recordRetryReason`), and `discuss` runs an interactive session that ends by distilling a conclusion explicitly "in a form a downstream implementation step can consume without the transcript" (`src/executors/discuss.ts:98-102`). A rejection reaches none of it, because `executeApprovalGate` ends a rejection as `error`, and `Engine.depCleared` only clears a dependency that is `done` or `skipped` by condition. Nothing downstream of a rejected gate can ever start, so no `when:` clause on a gate's out-edge could ever carry.

Three further facts shape the design, each verified against the code rather than assumed:

- `approvalGateOutput` is a `z.object`, Zod 4 strips unknown keys, and the engine records `parsed.data` (`src/engine/engine.ts:446`). The `diffs` the executor attaches are discarded before reaching the store, which is also why the detail panel's post-decision diff replay (`src/ui/App.tsx:936, 1665, 2387`) is unreachable code today.
- `resetNode` (`src/runstate/store.ts:282-309`) removes `output`, `statusDetail`, `startedAt`, `endedAt`, and `skipReason`, and keeps everything else — including `discussTranscript` and `sessionId`. A looped-back `discuss` therefore takes its resume path, which skips the only call to `upstreamPreamble` in the executor.
- `nodesBetween(target, source)` includes the source itself (`src/workflow/graph.ts:79-86`), so a node that is a loop-back source is reset along with the segment.

## Goals / Non-Goals

**Goals:**

- A rejection can route to another node, and that node's conclusion can loop back to `implement` as retry context.
- Existing workflow files behave exactly as they do today, with no edit and no rewrite of the file on disk.
- The revision step reuses `discuss`; no new node type enters the registry.
- A rejected run stays legible as a rejection — exit code, status line, and node card.

**Non-Goals:**

- Guest-mode support for the rejection branch. Guest reporting keeps its current terminal status, so guest runs are behaviourally untouched by this change.
- Any change to how the approve path works, to the approval port's `'approve' | 'reject'` shape, or to the keys that drive it.
- Enabling the rejection branch by default. It ships documented and commented out.

## Decisions

### Rejection ends as `done` with a recorded decision, not as `error`

The alternative — keeping `error` and expressing the rejection branch some other way — does not work. Loop-back targets must be upstream of their source, so a node that runs *only* on rejection cannot be a loop-back target, and `depCleared` blocks every forward path out of an errored node. Conditional routing is the only mechanism that can express "run this node on rejection", and it requires the gate to complete.

It is also the more honest model: a gate that received its answer completed. "The user said no" is a result, not an execution failure.

**Rejected:** adding `failsWhen` for the rejected verdict. `Engine.outputFailureDetail` would set the node straight back to `error` (`src/engine/engine.ts:295, 448-455`), reintroducing exactly the blockage being removed. The two mechanisms are mutually exclusive, and this is the most likely wrong turn during implementation.

### The approved-condition is synthesized at load time, not required of the author

Every existing workflow declares `{ from: gate, to: git-ops }` with no condition. Under the status change alone, a rejected gate would complete, `git-ops` would become eligible, and the rejected work would be committed. That is the single most dangerous consequence in this change, and it must be closed in the same commit.

Synthesis happens in `buildWorkflow` (`src/workflow/load.ts:327`), after nodes are built with resolved types and before `new Graph(...)`, so the synthesized conditions pass through the same structural validation as authored ones at `load.ts:468-487` (they pass trivially — the condition names the edge's own source). Both `new Graph` and the returned `Workflow.edges` receive the derived array.

**Rejected:** making an unconditional gate edge a load-time error. It is unambiguously safer to read but breaks every existing workflow file, both shipped presets, and the scaffolded default at once — a migration cost with no corresponding gain, since the synthesized condition is exactly what such an author would be forced to type.

**Rejected:** rewriting the user's `workflow.yaml` to materialize the condition. No writer round-trips `Workflow.edges` back to YAML today, and introducing one would edit a user's file as a side effect of loading it.

Exposing synthesized edges on `Workflow.edges` is safe and correct: the consumers are the canvas, layout, `validate`'s edge count, and the run record. A run record that reflects the graph that actually ran is right.

### The loop-back trigger widens rather than the rejection branch replacing it

`{ from: gate, to: implement, loopback: {...} }` is spec'd, tested, and advertised in every scaffolded repo. It is reached only from the `error` branch of `Engine.executeNode`, so the status change would silently delete it. The trigger widens to include a gate whose recorded decision is `rejected`; `markDownstreamSkipped` stays on the `error` path alone, because for a rejection the synthesized conditions already do that work.

This keeps two routes available with a clear division: the loop-back is the shortcut for "try again", and the rejection branch is for "try again, and here is what to change".

### A loop-back declares which outcome takes it

Found during implementation, not during design. `fireLoopback` is reached only from the failure branch of `Engine.executeNode`, so a revision step that *completes* can never send the run back — the conversation would happen and the run would simply end. Routing a rejection to a node is only half the feature; the node needs a way home.

`loopback.on` takes `failure` (the default, and what every verification loop wants) or `success`. A revision step is reached *because* work was turned down, and its conclusion is the reason to retry, so waiting for it to fail would mean waiting forever.

**Rejected:** firing a loop-back whenever its source ends, whatever the outcome. That would make `test`, `validate` and `review` loop back on success too — every passing check would restart the segment.

**Rejected:** reshaping the graph to avoid the problem — putting the revision step *upstream* of `implement` and making it the loop-back target, which works against the current engine unchanged (verified). It costs an agent session on every clean run, since the node then runs before any rejection exists, and it puts a step called "revise" before there is anything to revise. The point of gating the conversation behind a rejection was not to pay for it otherwise.

This does soften "edges carry no behavior". The line still holds where it matters: whether a node succeeded or failed remains the node type's call, and the edge says only where each outcome routes.

### A loop-back reconsiders the branch it routed around

Also found during implementation. With the segment re-running, a node skipped by an unmet condition stays `skipped` — `startEligible` only considers `idle` nodes — so the second pass would approve the gate and still never reach `git-ops`. The first pass's routing verdict outlives the inputs it was made from.

`fireLoopback` now returns every `condition`-skipped node below the loop-back target to `idle`. Scoped two ways: only below the target, and only `condition` skips — an `upstream` skip means something actually failed, which the re-run may well leave true. A new `clearSkip` is used rather than `resetNode`, so a node that never ran does not gain an attempt.

### The retry reason is delivered into the resumed session, not by forcing a fresh one

A looped-back `discuss` could be made to start clean by having `resetNode` clear the transcript and session id. That would lose the conversation the user just had, and would change reset semantics for the interrupted-conversation case that the resume path was written for.

Instead the executor distinguishes *why* it reset: an interruption leaves no retry reason, a loop-back does. When a retry reason is present, the preamble is sent as a fresh turn into the resumed session before control returns to the user — continuity preserved, agent informed.

### The revision node is a second `discuss` instance

Node ids must be unique; types need not be (`src/workflow/load.ts:334-337`). `discuss` already provides the interactive session, the persisted transcript, the tappable-options protocol, and a distillation step whose output shape is designed for exactly this hand-off. A new `revise` type would duplicate all of it.

Its role prompt is widened — "the discussion partner **at the start of** a coding workflow" is false on a rejection pass — which is a wording change affecting both placements.

**Rejected:** giving the Approval-Gate its own conversational phase by setting `agentDriven`/`interactive` on it. That flag is descriptive metadata, not a dispatch switch; the executor is what opens sessions. Setting it would make the optional critique unconditional on every existing gate, make gate-only workflows demand a provider, and contradict two documented invariants in `src/registry/types.ts`. Making `interactive` and `capabilities` conditional on a runtime branch turns one node type into two.

### Guest mode is held at its current behaviour, with the property made explicit

Guest validation has no condition evaluator — `unmetCondition` and `evaluateCondition` live only in the engine. If the guest's rejected gate became `done`, `upstreamSatisfied` would clear and downstream nodes would become startable in a reported run, silently removing "reject stops the run" from the guest tier.

`src/guest/validate.ts` keeps writing `error` on rejection. Separately, `upstreamSatisfied` is hardened to treat an Approval-Gate dependency whose decision is not `approved` as unsatisfied, mirroring the check `src/guest/enforce.ts:184-201` already uses for git-write blocking — which is why git writes stay blocked under either status. The property then rests on the recorded decision rather than on a status whose meaning is changing on the engine side.

## Risks / Trade-offs

**Rejected work reaches git because synthesis missed an edge** → The highest-severity failure in the change. Covered by three tests: synthesis applies to an unconditional gate edge, leaves an explicit condition alone, and ignores non-gate edges; plus the existing end-to-end assertion in `test/e2e.test.ts:210-218` that a rejected run leaves the repository with exactly one commit, kept verbatim.

**The skip reason changes from `upstream` to `condition`** → `depCleared` treats a `condition` skip as clearing a dependency and an `upstream` skip as not. The cascade still terminates correctly (a node whose dependencies are all skipped is itself skipped by condition), but this is the most likely silent breakage. Asserted directly rather than inferred.

**A rejected run looks like a successful one** → `runExitCode` counts `error` nodes and `attention()` fires only for `waiting | error | undriven`; both go quiet under `done`, and the node card colours red only on `error` while `outcomeSummary` already returns "rejected". All three are changed to key on the recorded decision, and the card is checked by eye in a real terminal, since that is what the surface exists for.

**The engine and the guest disagree about a rejected gate's status** → Real and accepted for this change: the engine records `done`, the guest records `error`, and the rejection branch does not run under guest mode. Stated in the proposal as a follow-up rather than left to be discovered.

**Two in-flight changes touch `approval-gate`** → `add-mcp-driver-connector` modifies the same capability, but only the approve path and its interaction surfaces. No semantic conflict; they need ordering at archive time.

**The diff crowds out other upstream context** → `upstreamInputs` shares one budget across every input (`src/engine/engine.ts:240-260`), so an untruncated diff in the gate's output would starve the review verdict. The diff is truncated at the gate before it is recorded.
