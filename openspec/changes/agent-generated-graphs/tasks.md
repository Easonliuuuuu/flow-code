## 1. The gate invariant (lands independently of everything else)

- [x] 1.1 Add a dominator computation to `Graph` (`src/workflow/graph.ts`) over the forward-edge subgraph, reusing the existing topological order; loop-backs excluded, conditional edges counted as present
- [x] 1.2 Look up whether a node's resolved type holds `git-write`, so the check keys on the capability and not on the `git-ops` type id
- [x] 1.3 Add the dominance check to the structure stage in `buildWorkflow` (`src/workflow/load.ts`), collected alongside `loopbackProblems` / `autoProblems` / `conditionProblems` so all independent failures report in one pass
- [x] 1.4 Write the failure message to name the git-writing node, the specific forward path that reaches it without passing a gate, and the alternative for an unattended run (remove the node and commit from the pipeline) — the message must not read as though the node at the head of the path is the offender
- [x] 1.5 Unit tests: no gate upstream; gate on one path with a bypass on another; a bypass carrying a `when:`; gate dominating; two independent branches each with their own gate; no git-writing node at all; reported together with an unrelated structural failure
- [x] 1.6 Assert the default scaffold and both shipped presets pass the new check
- [x] 1.7 Confirm `flow-code validate` reports the new failure without starting a run — a test, not new code, since both share the checks
- [x] 1.8 Assert there is no way to opt out: no `settings` key, no run flag, no headless auto-approve path
- [x] 1.9 Document the invariant in `docs/workflow-reference.md`, including what to add to an existing file that now fails and what an unattended pipeline does instead

## 2. The Plan node type

- [x] 2.1 Register the `plan` type in `src/registry/index.ts`: `read` capability, `interactive: true`, role prompt, and an output schema describing proposed nodes and edges
- [x] 2.2 Add the structural checks for it in `load.ts` — at most one Plan node, and it must be a root — reported with the other structure-stage problems
- [x] 2.3 Write the plan executor on the interactive session path Discuss already uses (`openInteractive`), so the node stays `running` until the user accepts
- [x] 2.4 Build the planner's prompt from the same node-type reference `flow-code node-types` prints, so its vocabulary and the registry cannot drift apart — factored into `nodeTypeReferenceLines()`, shared by `cmdNodeTypes` and the Plan prompt
- [x] 2.5 Give the planner's prompt the Implement/Test relationship: Implement holds `exec` and will test as it goes, so a following Test node is the verdict of record rather than the first run — and its cost is a judgement to make per task (whole suite when fast; Implement scoped to focused tests with Test running the suite once when slow)
- [x] 2.6 Tests: acceptance completes the node; amendment continues the session without completing; ending without accepting errors the node and skips downstream; a proposal naming an unregistered type is rejected
- [x] 2.7 Regenerate `docs/node-types.md` (`npm run docs:node-types`)

Required a new `PlanPort` interaction port (`engine/types.ts`), not scoped in the original plan: a three-way turn (chat / accept / abandon) is a different primitive from Discuss's two-way one (text / done), since "stopped talking" and "accepted a graph" have to be distinguishable for the completes-only-on-acceptance requirement to be real rather than text-sniffed. Implemented in `src/ui/ports.ts` (state + resolvers, mirroring `discuss`) and `test/helpers.ts`'s `fakePorts`. **Not done: App.tsx rendering and keybindings for the Plan panel** — the port exists and is exercised by executor-level tests, but nothing in the terminal UI yet lets a person actually drive it. That work belongs with Group 5 (the canvas already absorbs new nodes dynamically for Worktree-Agent; the Plan sub-panel is comparable scope to the Discuss panel it mirrors).

## 3. Propose, validate, repropose

- [x] 3.1 Build spine-plus-proposal through `buildWorkflow` in memory, with nothing spliced and nothing recorded on the failure path — `buildWorkflowFromRaw` (new, in `load.ts`) + `spliceProposal` (new, `workflow/splice.ts`)
- [x] 3.2 Return the full `WorkflowValidationError` problem list to the same session and let it repropose
- [x] 3.3 Surface a validation rejection inside the Plan node's conversation, so a retry is a visible turn rather than a hidden one
- [x] 3.4 Test the repair loop against a proposal that routes around the gate — caught by the 1.3 check, reproposed, never spliced
- [x] 3.5 Test that no graph failing validation is ever recorded to the run document or executed — verified at the executor level (an invalid proposal never produces a `result`/`done` event, so nothing downstream of the executor ever sees it); the run-document half of this claim is Group 4's to prove once expansion actually records anything

## 4. Graph expansion

- [x] 4.1 `Engine.run()` returns `EngineRunOutcome` (`{reason: 'finished'|'interrupted'|'awaiting-expansion', planNodeId?}`), source-compatible with every existing caller (none inspected the old `void`). Stops — draining anything else mid-flight in the same pass rather than abandoning it — the instant a Plan node reaches `done` *during that call*, before its successors' next `startEligible()` pass. `expandRecordedGraph` (`workflow/record.ts`) does the rebuild-and-record, reusing `spliceProposal` + `buildWorkflowFromRaw`.
- [x] 4.2 Superseded by a simpler mechanism than planned — see design.md. `RunStateStore.expandGraph(newGraph)` replaces the recorded graph **on the same store instance** (seeding only the node ids the expansion adds) rather than constructing a second store via `resumeFrom`; a new `Engine` is still constructed over the rehydrated expanded workflow, per the original decision not to mutate a running Engine's graph.
- [x] 4.3 `expandGraph` leaves every already-recorded node's state untouched by construction (only new ids are seeded `idle`); `Engine.run()`'s `alreadyDoneAtStart` snapshot is what stops a Plan node inherited `done` from ever being mistaken for a fresh completion, so it is never re-executed on a later `run()` call.
- [x] 4.4 `cli/run.ts` now drives this via the new exported `driveEngine(engine, workflow, {store, repoRoot, newEngine})`: loops constructing a fresh Engine on every `awaiting-expansion` outcome, returns once a final Engine reports `finished`/`interrupted`. Extracted to its own exported function specifically so it has direct test coverage (`test/driveEngine.test.ts`) rather than being untested inline glue in `cmdRun`.
- [x] 4.5 `test/expand.test.ts`: resume after expansion runs the expanded graph without re-entering Plan; resume before expansion re-enters Plan rather than treating it as complete
- [x] 4.6 `test/expand.test.ts`: `expandRecordedGraph`'s output round-trips through `rehydrateGraph`, and a proposal that would violate the gate invariant is rejected at this layer too (defense in depth over the Plan executor's own check)

## 5. The canvas

Landed materially smaller than planned — see design.md's expansion-mechanism note. `WorkflowHost` (`src/ui/index.ts`) already reactively re-derived its rendered `Workflow` from `store.subscribe` whenever the recorded graph's identity changed (built for `flow-code watch` reattaching to a live run); it only needed decoupling from the read-only-spectator behavior that happened to share its `watch` flag.

- [x] 5.0 `WorkflowHost`'s reactive effect no longer depends on `watch` at all — it now compares a `graphShapeKey` (node ids/types + edges, deliberately excluding per-node `config`) rather than gating on the flag, so an ordinary mid-run field edit (`m`/`s`/`e`, which also replaces `state.graph` by reference) does not pay for a `rehydrateGraph` it gets no benefit from, while a genuine shape change does — under `watch` or not. `watch` itself still independently governs read-only mode via the unchanged prop passed to `App`.
- [x] 5.1 (= 4.4) Done as part of `driveEngine` above.
- [x] 5.2 Proven directly, not by argument: `test/expandLayout.test.ts` asserts `computeLayout` produces byte-identical `NodeBox`es for an expanded graph and the equivalent hand-written file — true by construction, since layout is a pure function of `Workflow` with no notion of provenance, but worth a test that says so rather than relying on the argument holding forever.
- [x] 5.3 `test/ui.workflowHost.test.ts`: a Plan node expanding the graph is picked up and rendered within one settle cycle, with `watch: false`, on the same store instance — no restart, no remount.
- [ ] 5.4 **Not done.** Focus-preservation across an expansion (focused node survives vs. moves to a defined one) has no direct test — `WorkflowHost`'s tests assert the rendered *shape*, not `App`'s focus state across a `workflow` swap.
- [ ] 5.5 **Not done.** Panning/focus-brings-into-view for an expansion that grows past the viewport is untested — plausible given the shared layout path proven in 5.2, but not verified.
- [ ] 5.6 **Not done.** Hands-on `testbed` pass. Everything above this line is unit/component-tested against fakes; nothing has yet been watched happen in a real terminal against a real (or realistic fake) agent session — still the honest final check before calling this shippable.

## 6. The `planned` preset

- [x] 6.1 Added to `src/presets.ts` as `PLANNED_YAML` — a constant `plan → approval-gate → git-ops` file, `requiredSkills: []`, no `cli`
- [x] 6.2 True by construction, not a dedicated test: scaffolding any preset (`scaffoldWorkflow`) only does file I/O — no session runner is constructed or imported on that path, for `planned` any more than `openspec`/`spec-kit`
- [x] 6.3 `test/presets.test.ts`: the scaffolded spine loads, `order` is `[plan, gate, git-ops]`, `plan` is the sole interactive/root node, `git-ops` is dominated by `gate` with no loop-back on it

## 7. Keeping a planned graph

- [x] 7.1 `cmdRun`: once `driveEngine` returns, `finalWorkflow !== workflow` (reference inequality — the exact signal `driveEngine` exists to provide, see Group 4) is what triggers the offer via the existing `confirm()` prompt, inline before the run summary — no flag
- [x] 7.2 `stripPlanNode` (`workflow/splice.ts`) removes the Plan node and every edge touching it (it only ever has outgoing edges, so no bridging needed — its former successors just become roots); `writeKeptWorkflow` (`workflow/write.ts`) serializes via `yaml`'s `stringify`, re-validates the result before writing (defense in depth, matching every other writer in that file), and writes atomically (temp file + rename)
- [x] 7.3 Declining `confirm()` — `cmdRun` never calls `writeKeptWorkflow` — leaves the file exactly as `driveEngine` found it; not separately tested beyond the `confirm()` call being conditional, since there is no write path to have accidentally taken
- [x] 7.4 `test/writeKeptWorkflow.test.ts` and `test/plannedPresetE2e.test.ts`: a kept graph reloads with no Plan node and no interactive node at all

## 8. Documentation

- [x] 8.1 New "Planning the graph" section in `docs/workflow-reference.md` — the spine, what negotiation looks like, validation-and-repropose, splicing, and the keep-graph offer
- [x] 8.2 README: `planned` added alongside `openspec`/`spec-kit` in the methodology-presets bullet and the CLI reference table; a short addendum under "Why a graph, not a chat log" naming it as the one deliberate exception to "read before it runs" rather than leaving that claim standing uncontextualized now that the exception exists
- [x] 8.3 `test/plannedPresetE2e.test.ts` — the real chain end to end: `scaffoldWorkflow` writes the preset, `loadWorkflow` reads a 3-node spine, a harnessed session (real capability interception, real shell/write calls, real git commit — same fidelity as `test/e2e.test.ts`) negotiates and accepts a one-node proposal, `driveEngine` runs it through Implement → Gate → Git-ops to a real commit, `writeKeptWorkflow` keeps it, and a fresh `loadWorkflow` confirms the next run is `[impl, gate, git-ops]` with no interactive node
