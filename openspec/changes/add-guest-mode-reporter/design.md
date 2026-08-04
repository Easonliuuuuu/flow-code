## Context

flow-code's engine owns the model connection. `SessionRunner` implementations (`sdkRunner`, `codexRunner`, `openaiCompatRunner`) drive every agent node, and the capability harness (`harness/compile.ts` → `disallowedTools` + `PreToolUse` hooks + `canUseTool`) exists only because those SDKs expose an interception point. That architecture is what makes driver mode trustworthy, and it is also what makes flow-code a replacement for the agent CLI a user already has rather than an addition to it.

`FileRunStatePersister` writes the complete run-state document atomically to `.flow-code/runs/<runId>.json` on every mutation, and `RunStateStore` carries an explicit note that it has no dependency on the rendering layer. `flow-code watch` was built on exactly that seam: it hydrates a store from the file via `applySnapshot` and renders with no engine attached. The viewer therefore already works for any producer of that document — there is simply only one producer today.

This design covers the second producer. Its central constraint is that guest mode cannot inherit the harness: an external agent runs under its own tool permissions, and flow-code sees only what that agent chooses to report. The design's job is to make that honest and bounded rather than to pretend otherwise.

## Goals / Non-Goals

**Goals:**
- Let an external agent CLI produce a run-state document the existing viewer renders with no viewer changes beyond a provenance indicator.
- Reject reported transitions the workflow graph does not permit, so a misreporting agent produces an error rather than a wrong graph.
- Keep a guest and the engine from ever writing the same run document.
- Make the guarantees a guest run lacks visible in run-state and in the UI.
- Give a way to check claimed state against the repository, since claims are self-declared.

**Non-Goals:**
- Enforcing capabilities on a guest agent. Out of reach by construction; the design's answer is disclosure, not enforcement.
- Interactive approval gates in guest mode (a blocking `await_approval` tool answered from the watch window). Attractive, deferred — it turns the viewer bidirectional, which is a larger change than this one.
- Parallel fan-out, convergence, or worktree orchestration under a guest. A guest cannot be made to run three worktrees and return.
- Any new `SessionRunner`. Guest mode needs zero of them; that is most of its value.
- Passive derivation of state by tailing a host agent's own session logs. Undocumented per-tool formats, and it cannot know which node the user believes they are in. Possible later as enrichment, never as the source of truth.

## Decisions

**MCP as the primary surface, CLI as the fallback.** A tool in the model's tool list is far more salient than a shell command it must remember from an instructions file, and it gives structured arguments and a natural place to return a rejection the model can act on. The CLI exists because not every agent supports MCP and because it needs no registration step. Both compile to the same validation and the same writer — the spec requires them to be equivalent so the fallback is never a second-class path with its own bugs. *Alternative considered:* CLI only, matching OpenSpec's pattern exactly. Rejected as the primary because OpenSpec's known weakness is precisely agents forgetting to run the command.

**Reuse `Graph` for transition validation.** The ordering and loop-back rules in `workflow/graph.ts` already define which transitions are legal; guest mode applies them to externally-reported transitions instead of engine-driven ones. This keeps one definition of what the graph permits. *Alternative considered:* a permissive reporter that records whatever it is told. Rejected — it makes the graph a transcript of an agent's claims rather than a model of the workflow, which is the failure mode that makes a viewer worth less than nothing.

**Ownership recorded in run-state, checked on every write.** `RunState` already carries `pid`, and `isDriverAlive` already interprets it for the viewer. Guest writes extend that into a precondition: a guest report targeting a run owned by a live engine process is rejected. This is the one place where two writers could genuinely corrupt each other, so it is enforced rather than documented. *Alternative considered:* file locking. Rejected as heavier than needed and poorly behaved across the network mounts this feature is likely to span.

**Provenance and absent guarantees are recorded in the document, not inferred by the viewer.** The viewer should not have to guess from the shape of the data whether a harness was present. An explicit field means every consumer — UI, reconciliation, anything later — agrees on what the run was. It also forces the absent-guarantee list to be maintained as guest mode grows rather than drifting into folklore.

**Reconciliation is read-only and advisory.** It reports disagreement between claims and the tree; it never corrects run-state. Auto-correction would mean a checker overwriting a driver's record on the strength of a heuristic about which node types are expected to touch the repository. Reporting is enough to make a lying graph visible, which is the actual goal.

**Instructions are generated from `workflow.yaml`, not hand-written.** A hand-maintained instruction file describes the graph its author had; a generated one describes the graph the project has. Staleness detection exists because generation alone does not survive the workflow being edited afterwards.

## Risks / Trade-offs

- **A guest agent under-reports, and the graph lies** → The most likely failure, and the reason reconciliation is in scope. Mitigated in layers: MCP tools over remembered commands, rejection of illegal transitions, and a tree check that flags unsupported claims. None of these make compliance certain; together they make non-compliance visible.
- **Two producers double the surface for run-state bugs** → This is the stated reason the change is deferred until driver mode is more mature. `RunStateStore` currently assumes a single owning process, and that assumption becomes load-bearing rather than incidental.
- **Users read a guest run as carrying driver-mode guarantees** → Provenance in run-state plus a required UI distinction. The risk is real regardless: a graph looks equally authoritative either way, which is exactly why the disclosure is a spec requirement and not a nice-to-have.
- **An MCP SDK is a new dependency on a fast-moving protocol** → Confine it to the server boundary so the validation and writing logic underneath stays independently testable and reusable by the CLI path.
- **Ownership checks depend on pid, which is recyclable and meaningless across machines** → Already true of the viewer's liveness indicator. Acceptable for a stale-detection heuristic; not acceptable as the sole guard, so the guest path should also refuse to adopt a run it did not open.
- **Guest mode makes the weaker product the first thing new users meet** → Accepted deliberately. It is the adoption path; driver mode is the upgrade, and the UI distinction is what keeps the difference legible.

## Migration Plan

Purely additive: no existing command, file format, or workflow changes behavior. `flow-code run` and `flow-code watch` are untouched, and run-state gains optional provenance fields that older readers ignore. Rollback is removal of the new surfaces — existing runs and viewers are unaffected because nothing about the driver-mode path depends on them.

Sequencing note: this change assumes `flow-code watch`, which exists in the working tree but has no spec coverage. That gap should be closed before implementation, since the `terminal-canvas-ui` delta here builds on watch-mode requirements that are not yet written down.

## Open Questions

- Does a guest run open against a fresh run id every session, or resume the project's most recent unfinished guest run? Resuming matches how people actually work across several sittings; a fresh run per session is simpler and never merges two agents' claims.
- Which node types count as "expected to modify the repository" for reconciliation? Derivable from the node type's capability set, but `git-ops` and gate-style nodes need a deliberate answer.
- Should the CLI surface be `flow-code node <id> start|done|fail` or a single `flow-code report` verb? The former reads better in instructions; the latter is easier to keep in lockstep with the MCP tool list.
- How much of the harness can be recovered by sandboxing the guest process (cwd, env, the `pushurl` block already used in `compile.ts`) versus being genuinely unavailable? Worth settling before promising anything about guest-mode safety.
