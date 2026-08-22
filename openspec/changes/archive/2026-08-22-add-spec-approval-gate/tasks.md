## 1. The document channel

- [x] 1.1 Add `documents?: Array<{ label: string; body: string }>` to `ApprovalRequest` in `src/engine/types.ts`, documenting that it is the non-diff subject of a decision and that it comes from upstream results, never from gate config
- [x] 1.2 In `src/executors/gate.ts`, walk `directDependencies` and collect a document for each dependency whose output names one — for a `spec` dependency, read `join(ctx.repoRoot, output.specPath)` — labelled with the node id it came from
- [x] 1.3 Degrade rather than fail when a document cannot be read: the gate still presents whatever else it has, and records that it could not render that document. A gate that errors because it could not draw its subject turns a decision into an outage
- [x] 1.4 Bound each document body the way diffs are bounded, so a long spec cannot crowd the upstream summaries or blow the recorded-output budget
- [x] 1.5 Unit-test `gate.ts` document derivation: a spec upstream yields the file's bytes; a rewritten file on a second pass yields the new bytes; no document-producing upstream yields none and is not an error; an unreadable path does not fail the node

## 2. Rendering the gate panel

- [x] 2.1 Add a document render path to the approval panel in `src/ui/App.tsx` using `src/ui/markdown.ts`, separate from `diffLinesFor`/`DiffLines`
- [x] 2.2 Suppress the diff region when the gate has at least one document and its diff is empty; keep the existing "nothing to show" behaviour when there is neither
- [x] 2.3 Render the `upstreamSummaries` content, not just the node ids — bounded like the `agentSummary` block so it cannot displace the subject being decided on
- [x] 2.4 Keep the panel's scroll, `[a]`/`[r]`, drag and resize behaviour working over a document body, and keep the footer hint within `HINT_BUDGET`
- [x] 2.5 End-to-end render test: a gate with a bulleted spec document renders those lines as ordinary text, uncoloured — not as diff deletions — and no empty diff region appears
- [x] 2.6 End-to-end render test: a gate with both a document and a non-empty diff renders each on its own path, with additions and deletions still distinguishable
- [x] 2.7 Change `outputDetailLines` in `src/ui/nodeCard.ts` to emit markdown — `- **AC1** — …`, matching what `renderSpec` writes to the file — instead of pre-flattened text
- [x] 2.8 Render `nodePanelDetail` in `src/ui/App.tsx` through `markdown.ts` rather than `wrapText`, so the node view and the gate view of one spec agree; leave the raw-transcript fallback alone for output that has not parsed
- [x] 2.9 Check the other `outputDetailLines` cases — validate, review, discuss — still read correctly once their lines go through the markdown renderer; escape or rephrase any that emit stray markers (a review finding quoting `*` or `_` must not turn into emphasis)
- [x] 2.10 Render test: a finished Spec node's detail view shows emphasized criterion ids and no literal `**` markers; a running Spec node still shows its streamed transcript

## 3. Scaffolding the spec gate

- [x] 3.1 Add `spec-gate` (Approval-Gate) to `src/defaultWorkflow.ts` with the three edges from the design, and comment them the way the existing gate is commented
- [x] 3.2 Say in the scaffolded YAML that the run now stops for a human before Implement as well as before Git-ops, so the loss of unattended end-to-end execution is stated rather than discovered
- [x] 3.3 Say in the scaffolded YAML why the two gates differ — the spec gate's loop-back is scaffolded, the final gate's is documented but not enabled — and that `loopback: true` on a gate means "on rejection", since `failure` on a gate that was answered reads as a mistake
- [x] 3.4 Add the same gate and loop-back to the openspec and spec-kit presets in `src/presets.ts`, keeping each preset's own node ids
- [x] 3.5 Confirm the `planned` preset needs no change, or add the gate if it scaffolds a Spec node
- [x] 3.6 Test that all four scaffolded workflows still load and validate, that each with a Spec node has a gate between it and its downstream, and that the loop-back is present and legal

## 4. Wiring checks

- [x] 4.1 Verify `withGateApprovalConditions` auto-conditions `spec-gate → implement` on approval, so the scaffolded file does not state that condition itself
- [x] 4.2 Verify the `spec-gate → discuss` loop-back passes the ancestor check in `load.ts`, and that `withGateApprovalConditions` leaves a loop-back edge alone rather than conditioning it on approval
- [x] 4.3 Engine test: rejecting the spec gate fires the loop-back on the `failure` trigger via `wasRejectedGate`, resets `discuss`/`spec`/`spec-gate` and re-runs them, and does not cascade a skip into `implement`; approving takes the forward edge and fires no loop-back
- [x] 4.4 Engine test: the reopened `discuss` sees a retry reason, so `discuss.ts` takes its `resuming && retrying` branch — the earlier transcript survives `resetNode` and the reason arrives as a fresh turn in the same session, not a cold start. Rejecting twice must still resume; this is the failure mode the `revise` testbed mode exists to catch
- [x] 4.5 Engine test: the loop-back's `maxAttempts` is counted on `discuss` and exhausting it ends the run with the gate at `done` and the limit named, not at `error`

## 5. Documentation and verification

- [x] 5.1 Update the node-type reference and any docs describing the default graph's shape
- [x] 5.2 Run `npm run lint`, `npm run typecheck` and the full suite
- [x] 5.3 Drive it by hand: `/testbed clean`, `init`, then `run` to the spec gate — read the spec in the panel, reject it, check the discussion reopens knowing what it is reconsidering, then approve on the second pass
- [x] 5.4 Confirm the spec gate renders no empty-diff region and that its acceptance criteria are not coloured as deletions, in a real terminal rather than only in the render tests
