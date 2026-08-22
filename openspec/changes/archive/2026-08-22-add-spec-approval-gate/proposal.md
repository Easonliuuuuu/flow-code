## Why

The Spec node writes the run's contract — the requirements and acceptance criteria that Validate then checks one by one — and that contract is adopted with no human sign-off. The Plan node, whose output is a graph you can watch execute and correct, does not complete until the user explicitly accepts it. The binding artifact is the unreviewed one.

An Approval-Gate cannot close this today: its subject is a diff. The spec is written to `.flow-code/specs/<runId>.md`, which is ignored and outside the working tree the gate diffs, so a gate placed after the Spec node renders an empty body and asks the user to approve nothing.

## What Changes

- Approval-Gate gains a second thing it can put in front of a user: a **document**, alongside or instead of a diff. The gate reads it from its upstream dependencies — for a Spec dependency, the spec file itself, from disk, so what is approved is the bytes the run will use.
- The approval panel renders documents on their own path, not through the diff renderer. Diff rendering colours a leading `-` as a deletion, and a spec is acceptance-criteria bullets top to bottom; every criterion would read as removed.
- When a gate has documents and no diff, the documents are the body and the empty diff is not shown. "no changes" is true and misleading.
- The approval panel renders the upstream summaries the gate already collects. It currently shows only their node ids — the existing requirement to show "a summary of each upstream node's output" has never been met.
- The node detail view renders structured output through the same markdown path as the gate. Today a finished Spec node's breakdown is plain unstyled text — `- AC1 — …` where the file says `- **AC1** — …` — and while the node is running the panel shows the raw JSON blob the agent streamed. Two renderings of one spec that disagree is a reader's problem, not a formatting preference.
- The default, openspec and spec-kit presets gate the spec: `spec → spec-gate → implement` on approval, and on rejection a `loopback: true` edge from the gate back to the Discuss node already upstream. A rejected gate is reported to the engine as the `failure` trigger, so the bare loop-back fires on rejection and on nothing else. No new node, no new machinery.
- **BREAKING (behavioural, not API)**: a scaffolded workflow can no longer run start to finish unattended. There is now a blocking human decision before Implement, not only before Git-ops. Existing workflow files are untouched; this applies to what `init` writes from now on.

The gate stays plain — no `agent: true` critique of the spec. That is a separate, opt-in decision and it would put a per-run agent session behind a step whose whole point is that a human read it.

## Capabilities

### New Capabilities

None. This extends existing capabilities rather than introducing one — "a human decides" is what Approval-Gate already is, and the only thing it could not do was show something that is not a diff.

### Modified Capabilities

- `approval-gate`: the gate's subject widens from "the pending diff" to "the pending diff and/or documents drawn from upstream". Adds requirements for where a document comes from, how it is rendered, what happens when there is no diff, and the previously unmet requirement that upstream summaries reach the user.
- `workflow-graph`: the scaffolded default graph and the openspec and spec-kit presets change shape — a gate after the Spec node, a loop-back from it to the Discuss node already upstream, and the resulting loss of unattended end-to-end execution.
- `terminal-canvas-ui`: the node detail view's rendering of structured output becomes styled prose on the same path as the gate, so the two views of a spec cannot disagree.

## Impact

- `src/engine/types.ts` — `ApprovalRequest` gains an optional `documents` channel.
- `src/executors/gate.ts` — populates documents from direct dependencies; reads a Spec dependency's `specPath` from the repository root.
- `src/ui/App.tsx` — the approval panel gains a document render path (via `src/ui/markdown.ts`), suppresses an empty diff when documents are present, and renders the upstream summaries; the node detail panel renders `outputDetailLines` through that same path instead of `wrapText`.
- `src/ui/nodeCard.ts` — `outputDetailLines` emits markdown rather than pre-flattened text, so one renderer serves both views.
- `src/defaultWorkflow.ts`, `src/presets.ts` — the three scaffolded graphs gain `spec-gate` and its loop-back to Discuss.
- Anyone running `flow-code run` unattended against a newly scaffolded workflow. Existing checked-in workflow files are unaffected.
