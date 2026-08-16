## Context

`init` writes one of a fixed set of files today: the default scaffold or a named preset. `presets.ts` states the constraint that keeps that surface small — *"a preset is a scaffolded file and nothing more — it composes existing node types with skills, and adds no registry surface."* The `planned` preset is exactly that: a constant three-node file. Planning itself is not part of `init` at all.

Three existing properties make this change smaller than it first appears.

**A run is already decoupled from the workflow file.** The run document records the graph the run is executing (`runstate/types.ts:360`), and `--resume` executes *that* graph rather than the current file, saying so out loud: *"continuing its recorded graph, not the current workflow file."* The idea that a run's graph is not the file's graph is already implemented and already user-facing.

**The store already takes a graph plus prior node state.** `new RunStateStore({ repoRoot, graph: recordGraph(workflow, graphName), resumeFrom: resumeState })` (`cli/run.ts:265`) is the resume path. Expansion is the same call with a freshly proposed graph instead of a rehydrated one.

**Interactivity is already a registry field.** `interactive: boolean` (`registry/types.ts:38`) — Discuss is the only `true`. A second interactive type costs a registry entry and an executor, not new machinery.

One fence is missing. `withGateApprovalConditions` (`load.ts:330`) derives `when: <gate>.decision == 'approved'` onto every forward edge leaving an Approval-Gate — that is the entire enforcement mechanism, and it only fires for edges that leave a gate. Nothing requires a git-writing node to have a gate upstream at all. A hand-written file that wires Git-ops with no gate loads today and commits without asking. Tolerable when a human wrote the graph; not tolerable when a planner proposes it, because the guarantee would become something the model opts into.

## Goals / Non-Goals

**Goals:**

- A run can be shaped for its task, negotiated conversationally, using only existing node types.
- The user agrees to the graph before any work happens.
- A shape worth reusing can be kept as an ordinary static workflow.
- The approval-gate guarantee holds structurally, for planned and hand-written graphs alike.
- No new CLI command. `init` and `run` remain the whole surface.

**Non-Goals:**

- A Plan node anywhere but the root; more than one per graph; a Plan node expanding into another.
- Replanning after the expanded graph starts executing.
- A runtime agent loop where node types become callable tools.
- New capabilities. The Plan node holds `read`, and what it proposes runs under each type's existing capability set.

## Decisions

### Planning is a node, not a phase in `run`

The alternative was a step inside `cmdRun` between Discuss and the rest. Rejected on the project's own rule: *"All blocking, gating, and approval behavior SHALL be expressed by placing nodes on the graph, never by annotating edges."* Behavior that happens is a node. A planning phase hidden in the CLI would have no card, no status, no detail view, no attempt history, and no place in the run document — every affordance the rest of the system provides for "something is happening" would have to be special-cased for it.

As a node it gets all of that for free, and the scaffolded file says plainly what the run will do.

### Approval is intrinsic to the conversation, not a separate step

The Plan node is interactive, so it behaves as Discuss does: it does not complete until the user is satisfied. The agent proposes a shape, the user pushes back, the agent revises, the user accepts — and acceptance is what completes the node.

*Alternative considered:* a headless planner that writes a proposal, followed by an Approval-Gate on the graph itself. Rejected — it produces a YAML diff to approve or reject with no way to say "drop Review, this is a typo fix" except editing the file by hand. Negotiation is the affordance that makes planning useful, and an interactive node already has it.

Consequently no Approval-Gate is needed for the graph. The gate in the spine is for the diff, as it has always been.

### The gate invariant is dominance, not ancestry

The obvious check — *a git-writing node must have an Approval-Gate ancestor* — is too weak. This graph passes it and is still ungated:

```
spec ─→ gate ─→ git-ops
  └───────────────↑        # second path, no gate on it
```

`git-ops` has a gate ancestor and also a path that never touches one. The requirement is that **every path from every root to a git-writing node passes through an Approval-Gate** — dominance over the forward-edge subgraph. `Graph` already computes `ancestorsOf` and a topological order, which is what a dominator computation needs. Loop-backs are excluded from the forward subgraph and so are out of scope naturally.

*Alternative considered:* accepting ancestry and treating the hole as unlikely. Rejected — it is exactly the shape a plausible-looking proposed graph would produce. A convenience edge from an early node straight to Git-ops is a natural thing to draw and the result reads fine.

### Conditional edges count as present for dominance

Both cases point the same way. The gate's own outgoing edges are auto-annotated with `when: <gate>.decision == 'approved'`; if conditional edges counted as absent, that edge would vanish and a correctly gated Git-ops would look rootless. And a user's `when:` on a bypass edge is a path that commits without approval whenever it fires — treating it as absent would let a planner route around a gate by attaching a condition. A conditional edge is a path that might carry, and dominance assumes it does.

### The invariant keys on the capability, not the node type

The check asks whether a node's type holds `git-write`, not whether its type id is `git-ops`. A future type granted that capability is covered the day it is added rather than the day someone remembers a list. This matches how the system already treats capabilities as the real boundary — *"a node without `edit` cannot write files, whatever its instructions say."*

### A proposal is validated before it is spliced, and rejection feeds back into the conversation

The proposed graph is built through `buildWorkflow` in memory — every node type, config schema, settings, and structural check, including gate dominance. A proposal that fails is not spliced; the failures go back into the same interactive session, which revises and reproposes. Because validation *"SHALL report all independent failures it can detect in one pass rather than stopping at the first"*, the loop gets everything at once and converges. The validator is the planner's test harness, and it is code rather than a rubric.

The user sees this happen — it is a conversation, so a rejected proposal is a turn in it, not a hidden retry.

### Expansion reuses the resume path — as implemented, in place on the same store

Landed simpler than first planned. `Engine.run()` now returns a discriminated `EngineRunOutcome` — `{reason: 'finished' | 'interrupted' | 'awaiting-expansion', planNodeId?}` — rather than `void`, source-compatible with every existing caller since none inspected the old `void` return. It tracks which nodes were already `done` when a given `run()` call began, and treats a Plan node reaching `done` *during that call* (never one inherited already-done) as the signal to drain whatever else happened to be running in the same pass and return `awaiting-expansion` before its own `startEligible()` would otherwise start the node's successors on the next pass. A Plan node inherited `done` — post-expansion, or via `resumeFrom` — is an ordinary completed node and triggers nothing.

`RunStateStore` gained `expandGraph(newGraph)`: replaces `state.graph`, seeds run-state only for the ids the new graph adds, and leaves every already-recorded node (the Plan node, `done`; anything else, still `idle`) untouched — the same `commit()`-and-notify path `patchGraphNode` already uses for an ordinary mid-run edit. The caller (`cli/run.ts`, not yet wired — see Risks) then constructs a **new `Engine`** over the same store and the rehydrated expanded `Workflow`, per the original decision below.

*Alternative considered, and implemented first, then backed out:* a fresh `RunStateStore` via `resumeFrom`, as this section originally specified. Correct, but strictly more machinery for the same result — `resumeFrom`'s reset-non-`done`-nodes-to-`idle` behavior exists for an *interrupted* run's leftover state, and there is none of that here (everything past Plan is already `idle`, having never started). It also creates a second store object, which would have needed `cli/run.ts` to re-mount the terminal UI to point at it. `expandGraph` mutating the existing store avoids that: `WorkflowHost` (`src/ui/index.ts`) already re-derives its rendered `Workflow` reactively from `store.subscribe`, by reference, whenever `state.graph` changes — built for `flow-code watch` reattaching to a different run, but the mechanism doesn't know that's why it exists. The graph-reactivity and the read-only-spectator behaviors are gated by the same `watch` flag today; unhooking them so `cmdRun`'s own (non-watch) session picks up the reactive update too is exactly the remaining `cli/run.ts`/`ui/index.ts` wiring — see Risks. This is very likely most of what Group 5 turns out to be, not new canvas work.

*Alternative considered:* mutating the running Engine's graph in place. Rejected — the Engine computes its topological order at construction, and a graph that changes underneath it makes every derived structure suspect. Constructing a new Engine is both simpler and already a proven path.

### Interactive-holds-the-run generalizes from Discuss to "any interactive type"

The engine already refused to start new nodes while a Discuss node was `running`/`waiting`, and froze further starts in the same `startEligible()` pass the instant a Discuss node started. Both checks keyed on `n.type.id === 'discuss'`; both are now `n.type.interactive`, matching the gate invariant's own precedent of keying checks on a declared property rather than a type id. Plan inherits both for free, and a future interactive type would too.

One consequence worth being explicit about, found while testing rather than anticipated in the plan: because *starting* an interactive node freezes further starts within the same pass, a Plan node can only ever be started alongside another root that is *declared before it* in the workflow file — `startEligible` walks `wf.order`, which preserves declaration order among nodes with no dependencies, and starting Plan breaks the loop before any node declared after it is even considered. This is what makes the "drain the rest of `running` rather than abandoning it" safeguard in `run()` reachable at all outside of contrived test setups, and it is pre-existing Discuss behavior, not something this change introduces.

### One Plan node, and it must be a root

Constrained deliberately for this change. A Plan node with completed ancestors, two Plan nodes expanding into each other, or one expanding over a node already running each raise real questions about what the reset scope is and what the recorded graph means. Generalizing later is easy; un-generalizing is not.

### Keeping a planned graph is an offer, not a flag

After a run, the expanded graph can be written back to `.flow-code/workflow.yaml`, replacing the spine. Offered inline at the point the user can judge whether the shape was good — not as a flag they had to know about beforehand. A kept graph is an ordinary static workflow with no Plan node, so the next run does no planning at all.

## Risks / Trade-offs

- **The new invariant breaks existing workflow files.** Any repo whose git-writing node is not dominated by a gate stops loading. → The error names the node, the path that misses a gate, and what to add. `flow-code validate` surfaces it without starting a run, and the default scaffold plus both shipped presets already satisfy it, so only hand-edited graphs are affected.

- **The scaffolded file no longer shows the shape.** A reader opening a `planned` workflow sees three nodes and learns the middle is negotiated per run. → Accepted, and bounded: the mode is opt-in, the default scaffold is unchanged, the run document records what actually ran, and keeping a graph converts the file back to a full static one. Reviewability is deferred to the run rather than lost.

- **The canvas must grow mid-run.** It renders three nodes, then N, after the first node completes — layer assignment, viewport, and focus all have to survive that. → Smaller than expected: `WorkflowHost` already re-derives its rendered graph reactively from the store (see above), gated by the same `watch` flag that also disables per-node interactive keys. The remaining work is narrower than "new canvas machinery" — decouple those two behaviors so `cmdRun`'s own session gets the reactive redraw without becoming read-only, then have `cmdRun` actually call `store.expandGraph` + construct the next `Engine` when `run()` returns `awaiting-expansion`. **Neither is done yet** — `Engine`/`RunStateStore`/`workflow/record.ts` all carry and expose what this needs (`EngineRunOutcome`, `expandGraph`, `expandRecordedGraph`), tested at that level, but nothing calls them from `cli/run.ts`. A Plan node in a real run today would negotiate correctly and then sit there — `cmdRun` never notices `awaiting-expansion` and never expands. Layer assignment, viewport, and focus across a layout change are still a thing to look at by hand once the wiring exists, since `WorkflowHost`'s reactivity was proven under `watch` (a different call site, different test coverage) and not yet under this one.

- **A negotiated graph can still be wrong.** The user may accept a shape that turns out badly. → It is a quality problem, not a safety one; the structural checks hold either way, per-node budgets bound the cost, and the answer is another run.

- **The plan is frozen once expansion completes.** If the shape turns out wrong at node four, the run can only loop back along edges the plan drew. → Accepted. Cheap replanning — every run starts from the Plan node — is the answer, rather than a mutable graph.

- **Planning costs a conversation before any code is written.** For a trivial task that is overhead. → The mode is opt-in per repo, and the keep-this-graph offer converts a repo out of planning entirely once a good shape exists.

### An ungated git-writing graph is refused outright, with no opt-out

An unattended run has no one to approve, and a graph of `implement → test → git-ops` is expressible today. The invariant removes it. **Decided: refuse, with no setting and no flag.**

The use case survives without one. An unattended pipeline leaves Git-ops out of the graph and commits itself after flow-code exits — it already has git credentials and already runs shell steps. What is lost is the commit message Git-ops composes from upstream context, which an upstream node's output can supply instead. A real but narrow downgrade.

*Alternative considered:* `settings.allowUngatedGitWrite`. Rejected on blast radius — `workflow.yaml` is checked in, so a flag set for one unattended pipeline disarms every run in that checkout, including interactive ones and ones whose graph a Plan node proposed. It also propagates by copy-paste through CI templates, and it turns a claim verifiable by reading the README into one that requires auditing every workflow file in every repo.

*Alternative considered:* a per-run `--no-gate` flag. Fixes the blast radius, but puts "skip the safety property" on the command line of the two commands a user is meant to learn, where it would live in a CI invocation forever.

*Alternative considered:* auto-approving the gate when there is no terminal. Rejected as worse than either — the run log would record `approved` for a decision nobody made, which fabricates evidence rather than merely lacking it.

The refusal is a narrowing with a clear way out, not a wall: a gate is human-bound, not terminal-bound, and resolving one from a PR review, a signed token, or a file another system writes would restore the unattended case with the invariant intact. That is a separate change and is deliberately not stubbed here.

Because the invariant blocks something legitimate, its error SHALL name the alternative rather than only the violation — add a gate, *or* remove the git-writing node and commit from the pipeline after `flow-code run` exits.

### The planner is told that Implement usually tests as it goes

In practice an Implement node runs the test suite itself — it holds `exec`, and a tight edit-test loop is what a competent agent does. The Test node that follows is therefore usually re-running something that already passed.

That is not waste, and the planner's prompt says why: Implement's testing produces a claim inside a transcript, while the Test node produces `{passed, commands: [{command, exitStatus, output}]}` in run-state — the verdict of record that a loop-back edge routes on and that Validate and the gate can read. *"The verdict is an exit code, never a model's opinion"* is a property of the node, not of whether the command has been run before.

What the planner may do with that is decide how much the second run costs. A fast suite: run it whole. A slow one: Implement's instructions scope it to the focused tests, and the Test node runs the full suite once. That is a per-task judgement a single static default graph cannot express and a negotiated one can.
