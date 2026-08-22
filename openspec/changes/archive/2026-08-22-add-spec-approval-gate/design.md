## Context

`executeSpec` writes `.flow-code/specs/<runId>.md` from the repository root and yields straight to `done`. The Spec node is `interactive: false`. Everything downstream is judged against its acceptance criteria — `validate` checks them one by one — and nothing in the run asks a human whether they are the right criteria. `plan`, whose output is a graph the user can watch execute and correct, is `interactive: true` and errors if the user never accepts.

An Approval-Gate is the mechanism the codebase already has for "a human decides", and the routing around a decision is already general: `withGateApprovalConditions` (`src/workflow/load.ts:330`) rewrites an unconditional edge out of a gate to `when: <gate>.decision == 'approved'`, and the approval-gate spec already requires that a rejection be routable to another node. What the gate cannot do is show a subject that is not a diff:

- `ApprovalRequest.diffs` is the only content channel (`src/engine/types.ts:75`).
- `.flow-code/` is ignored and the spec is written to `repoRoot`, so `diffAgainstTree(workingDir, baseline.tree)` returns empty for a gate placed after Spec.
- The panel body is `diffLinesFor(req.diffs)` (`src/ui/App.tsx`), and `gate.ts` builds `upstreamSummaries` that the panel renders as node ids only — the summaries themselves never reach the screen, though the approval-gate spec has always required them to.

So a gate after Spec today renders `upstream: spec` above an empty body and asks for a decision.

## Goals / Non-Goals

**Goals:**
- An Approval-Gate can gate a document, deriving it from its upstream dependencies with no gate configuration.
- The spec is signed before Implement runs, in the default graph and every preset that has a Spec node.
- Rejecting the spec reopens it with the user's reason and loops back, rather than ending the run.
- The upstream summaries the gate already collects reach the user.

**Non-Goals:**
- No `agent: true` critique of the spec. It would put a per-run agent session behind a step whose entire value is that a human read the thing.
- No new node type. "A human decides" is Approval-Gate; adding a second way to do it is the outcome this design exists to avoid.
- No change to how the Spec node itself executes, or to where it writes.
- No document channel for gates the user configures by hand pointing at arbitrary files. Documents come from upstream results only.

## Decisions

### Gate a document rather than making Spec interactive

The alternative was to give `spec` the `plan` treatment: `interactive: true`, blocking in-node, accept-or-give-feedback. That produces a more natural feedback loop — you say "AC3 is untestable" and it rewrites, with no graph edges involved — but it re-implements per node type the thing `approval-gate` was factored out to be, and it offers accept-or-error with no reject-and-route. Extending the gate instead means the routing, the skip-not-fail semantics, the recorded decision, the loop-back and the `contextTransparent` pass-through all apply unchanged, and the same extension makes gates usable after any node whose result is not a diff.

### Documents are derived from direct dependencies, not configured

`gate.ts` already inspects `directDependencies` to find a Worktree-Agent upstream; documents follow the same shape. A gate placed after a Spec node therefore needs no config, which matters because the scaffolded presets are documentation people read — `- id: spec-gate / type: approval-gate` says what it does without a pointer to a path.

### A document's body is read from disk, not re-rendered from the output object

The Spec node records `specPath`, and `nodeCard.ts:260` can already render title, requirements and criteria from the output object. Using that renderer would mean the user approves a second rendering of the spec while downstream nodes read the file. Reading `join(repoRoot, output.specPath)` means what was approved is the bytes the run uses. It also makes the loop-back case correct for free: Spec rewrites the same `runId` path, so the second pass reads the rewritten file with no cache to invalidate.

### Documents get their own render path, not `diffLinesFor`

`diffLinesFor` + `DiffLines` colour a leading `-` red and a leading `+` green. A rendered spec is `- **AC1** — …` bullets from top to bottom; every acceptance criterion would display as a deletion. `src/ui/markdown.ts` already exists for prose. This is the one part of the change that is a correctness issue rather than a plumbing issue, and it is why the specs state it as a requirement rather than leaving it to implementation.

### An empty diff is suppressed when documents are present

For a spec gate the diff is always empty — nothing has been written yet. Rendering "no changes" beside an approve/reject prompt states something true about the wrong subject. Documents lead; the diff region is omitted when it is empty and a document exists. When there is neither, the existing "nothing to show" behaviour stands.

### Rejection loops back to the Discuss node already in the graph

No new node, one edge:

```yaml
- { from: spec, to: spec-gate }
- { from: spec-gate, to: implement }   # auto-conditioned on approval
- { from: spec-gate, to: discuss, loopback: true }
```

`when` is not meaningful on a loop-back (`schema.ts:118`) and both decisions leave the gate at `done`, so the trigger cannot come from either. It comes from `wasRejectedGate` (`engine.ts:533`): a gate whose output is `decision: 'rejected'` is reported to `fireLoopback` as the `failure` trigger even though it completed. `failure` is `DEFAULT_LOOPBACK_TRIGGER`, so a bare `loopback: true` fires on rejection and on nothing else. That path is not incidental — the comment there records that a gate looping back on rejection predates rejection branches and stays supported.

The loop-back is legal because `discuss` is an ancestor of `spec-gate` (`load.ts:466`). It resets `discuss`, `spec` and `spec-gate` and re-runs the segment.

The rejection reason comes from the user, not from a channel. `approval.request` resolves to `'approve' | 'reject'` with no text, so `recordRetryReason` carries only `{decision: 'rejected'}` — but `discuss` is interactive, so the user says what was wrong in the node the loop-back reopens. `discuss.ts:59-68` distinguishes the two ways it can be reset: `resuming` (transcript and `sessionId` survive `resetNode`, which preserves both) with `retrying` (an upstream carries a retry reason) sends a reopening turn — "you are picking this discussion back up because the work that followed it was sent back" — into the existing session. A plain `--resume` after ctrl+c gets no such turn. That branch exists for exactly this case.

**Alternative considered: a dedicated `respec` Discuss node**, reached by `when: "spec-gate.decision == 'rejected'"` and looping back to `spec`. It works and keeps the original discussion untouched, but it costs a node and an edge in every preset, splits the conversation about a change across two nodes, and duplicates a resume path the existing node already has. Its one real advantage — a `topic` scoped to revision rather than to the change — is not worth a second Discuss node in three scaffolded graphs.

### The spec gate has a rejection branch; the final gate still does not

The existing scaffold requirement says the Approval-Gate has no rejection branch, so a rejection ends the run, with the alternative documented but not enabled. That stays true of the gate before Git-ops and is deliberately not extended to the spec gate: a spec is rejected in order to be rewritten, whereas finished work is rejected in order to be abandoned. The scaffolded file should say this, since two gates behaving differently is otherwise the kind of inconsistency a reader assumes is an oversight.

## Risks / Trade-offs

- **A scaffolded run can no longer complete unattended** → Stated in the proposal, written into the spec as a scenario, and documented in the scaffolded YAML itself. Anyone scripting `flow-code run` against a fresh scaffold will hit a blocking gate before Implement. Mitigation is that existing checked-in workflow files are untouched; only what `init` writes from now on changes.
- **Every rejection costs two agent sessions** → the loop-back resets `discuss` *and* `spec`, so both re-run. `discuss` resumes rather than restarts, but `spec` writes the file again from scratch. Default `maxAttempts` (3) bounds it, counted on the target (`discuss`) and shared with any other loop-back pointing there — none in these presets today, but a user adding one shares the budget rather than doubling it.
- **Three presets grow by one node and two edges** → The preset YAML is read as documentation. Mitigation: comment the spec gate the way the existing gate is commented, and say on the loop-back edge that it fires on rejection — `loopback: true` reads as "on failure" and a gate that was answered did not fail.
- **`discuss` resumes its session across rejections** → This is the behaviour the `revise` testbed mode exists to check: a second rejection must land as a fresh turn in the earlier conversation, not a cold start. It needs checking here too, and it is the most likely place for a real bug.
- **The original discussion is reopened rather than left alone** → the conversation about what the change should accomplish now also carries "the spec you produced was wrong". `resetNode` keeps the transcript, so nothing is lost, but a long revision thread makes the node's history harder to read. Accepted: one conversation about one change is the more honest shape.
- **Reading a document from disk can fail** → The file may be missing if a user hand-edited the run state, or unreadable. The gate must degrade to presenting whatever else it has rather than failing the node: a gate that errors because it could not render its subject converts a decision into an outage.

## Migration Plan

No migration. `documents` is optional on `ApprovalRequest`, so existing gates are unaffected and existing workflow files load and run exactly as before. The change is visible only in what `init` scaffolds from now on and in what a gate placed after a Spec node can show.

## Open Questions

- Should `flow-code validate` warn when a graph contains a Spec node with no gate between it and its downstream? It would push the practice without forcing it, but it is a lint rule about workflow shape and the loader has so far stayed out of that business. Deferred.
