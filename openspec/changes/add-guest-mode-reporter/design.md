## Context

flow-code's engine owns the model connection. `SessionRunner` implementations (`sdkRunner`, `codexRunner`, `openaiCompatRunner`) drive every agent node, and the capability harness (`harness/compile.ts` → `disallowedTools` + `PreToolUse` hooks + `canUseTool`) exists only because those SDKs expose an interception point. That architecture is what makes driver mode trustworthy, and it is also what makes flow-code a replacement for the agent CLI a user already has rather than an addition to it.

`FileRunStatePersister` writes the complete run-state document atomically to `.flow-code/runs/<runId>.json` on every mutation, and `RunStateStore` carries an explicit note that it has no dependency on the rendering layer. `flow-code watch` was built on exactly that seam: it hydrates a store from the file via `applySnapshot` and renders with no engine attached. The viewer therefore already works for any producer of that document — there is simply only one producer today.

The original version of this design stated its central constraint as: guest mode cannot inherit the harness, because an external agent runs under its own tool permissions and flow-code sees only what that agent chooses to report. **For a Claude Code host that is false, and the correction is what this revision is about.** Verified against the host's documented behavior as of August 2026:

- A `PreToolUse` hook returns `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}`, blocking a tool call before it runs and telling the model why. `updatedInput` can rewrite arguments. This is the same interception point `src/harness/intercept.ts` sits on, exposed to a process that did not spawn the session.
- A `Stop` hook can decline to let a turn end and attach `additionalContext`, which the model receives as a system reminder rather than a chat message.
- A `SubagentStart` hook fires when the session delegates, so a node run as a subagent can be scoped rather than trusted.
- A plugin bundles an MCP server, skills, hooks, and settings behind one `/plugin install`, which removes the manual registration step the original design assumed.
- MCP elicitation gives a server a native interactive dialog in the session, and a tool annotated `requiresUserInteraction` always shows its full permission prompt — no one-tap approval, no allow-rule bypass, denied outright in `dontAsk` mode.

What remains genuinely out of reach is everything that depends on having spawned the process: the `env` half of `CompiledToolPolicy` (notably the `pushurl` block), the working directory, per-node model selection, and exact token accounting. So this design's job is no longer to make an absence honest — it is to be precise about a middle tier that did not previously exist.

## Goals / Non-Goals

**Goals:**
- Let a user stay in their own Claude Code session and get the graph, the gate, and per-node capability enforcement, with no nested agent session and no second subscription.
- Reuse `harness/compile.ts` and `harness/gitCommands.ts` for host-session enforcement rather than restating either, so the two paths cannot drift into disagreeing about what a node may do.
- Preserve per-node context isolation by running nodes as host-session subagents.
- Record which guarantees were in force on every run, and make the viewer report that rather than a boolean.
- Reject reported transitions the workflow graph does not permit, and check claims against the tree, exactly as before.
- Keep the CLI surface working for hosts with no equivalent interception point.

**Non-Goals:**
- Enforcing capabilities on a host that exposes no interception point. Those hosts get the `reported` tier, and the answer there is still disclosure.
- Per-node model selection or exact token accounting in a host session. One session, one model, one bill.
- Parallel fan-out, convergence, or worktree orchestration under a guest.
- Interactive approval gates answered from the watch window. Attractive, deferred — it turns the viewer bidirectional, which is a larger change than this one.
- Any new `SessionRunner`. This change needs zero of them; that is still most of its value.
- Passive derivation of state by tailing a host agent's session logs. Undocumented per-tool formats, and it cannot know which node the user believes they are in.

## Decisions

**The plugin is the unit of installation, not the MCP server.** One `/plugin install` delivers the report tools, the skill, the hook scripts, and the settings that register them. The original design's "register the MCP server, then install an instructions fragment" is two manual steps, and the proposal's own argument — that a tool in the model's tool list beats a command it must remember — applies one level up: an install the user completes beats a configuration they intend to finish later. *Alternative considered:* keep manual registration and document it well. Rejected because the failure it produces is invisible — a half-installed guest mode looks like a working one until the run is wrong.

**Host-session enforcement compiles the same policy the engine compiles.** The `PreToolUse` hook resolves the run's current node from run-state, calls `compileToolPolicy` with that node's capability set, and denies anything outside it, running `gitCommands.ts` over Bash invocations for the git half. No second policy definition exists. *Alternative considered:* express the policy as `permissions.deny` rules in the plugin's settings. Rejected as the primary mechanism: settings rules are per-session and static, and the whole point is that the envelope changes as the run moves between nodes — though settings rules remain a useful backstop for the tools no node ever gets.

**A hook that fails, denies.** If the hook script errors, times out, or cannot read run-state, the tool call is denied rather than allowed. An enforcement layer whose failure mode is silent permissiveness is worse than none, because the tier recorded in run-state would claim a guarantee that was not delivered. This is the one place the design accepts a usability cost outright.

**Enforcement is recorded as a tier, not a boolean.** `engine` — flow-code spawned the session: tool policy, process guards, accounting. `hooks` — a host session with the plugin's hooks verified active: tool policy and git interception, no process guards, coarse accounting, no per-node models. `reported` — self-reported only, no enforcement. The tier is written into run-state at run open and re-verified rather than assumed, and every consumer (viewer, reconciliation, anything later) reads the same field. *Alternative considered:* the original boolean `guestDriven` plus a list of absent guarantees. Rejected — the list was maintained by prose and would have needed a third state the moment hooks landed anyway.

**Nodes run as host-session subagents.** Each node's work is delegated with that node's role prompt, so the node gets fresh context under the user's own configuration, and `SubagentStart` scopes it. Collapsing the graph into one long session would put Implement and Review in one context window, which makes the reviewer the author — the specific failure the graph exists to prevent. *Alternative considered:* one sequential session with prompt-level role switching. Rejected on that ground, but recorded because it is the fallback if subagent scoping turns out not to be reliably attributable to a node.

**The gate's human is guaranteed by the permission prompt, not by the dialog.** The approval tool is annotated `requiresUserInteraction`, which forces its full permission prompt on every call — no one-tap approval, no allow-rule bypass, and a denial rather than a silent pass in `dontAsk` mode. Elicitation then collects approve or reject. This ordering matters because Claude Code also offers an `Elicitation` hook that can auto-respond to dialogs without showing them: a gate answered by a script is not an approval, and the permission-prompt annotation is the part of the mechanism a user's own automation cannot quietly satisfy. *Alternative considered:* elicitation alone. Rejected on exactly that hole.

**Loop-backs are steering, and the spec says so.** A `Stop` hook can refuse to end a turn and inject the loop-back edge as context; it cannot make the session run a node. Enforcement in a host session is negative — it denies — and nothing in this change makes it positive. Reconciliation remains the check on whether the steering worked.

**The CLI surface and reconciliation are unchanged from the original design.** `flow-code node …` exists because not every agent supports MCP and because it needs no registration step; both surfaces compile to the same validation and the same writer. Reconciliation stays read-only and advisory: it reports disagreement between claims and the tree and never corrects run-state.

**Ownership stays recorded in run-state and checked on every write.** `RunState` already carries `pid`, and `isDriverAlive` already interprets it. A guest report targeting a run owned by a live engine process is rejected. *Alternative considered:* file locking. Rejected as heavier than needed and poorly behaved across the network mounts this feature is likely to span.

## Risks / Trade-offs

- **The hook contract is a host's implementation detail, not a stability promise** → Confine every assumption to one script plus a capability check at install time, and downgrade the recorded tier to `reported` when the check fails. A silently-changed hook schema must cost enforcement *and* the claim of enforcement, never just the enforcement.
- **A user can disable hooks after installing the plugin** → The tier must be verified per run rather than trusted from the presence of a plugin. See open questions: the verification mechanism is not settled.
- **Enforcement is evadable through indirection** (a script that shells out to git from inside another program) → True, and equally true of driver mode, which intercepts the same Bash calls with the same parser. Not a new hole; worth stating so it is not read as one this change introduces.
- **A guest agent under-reports and the graph lies** → Still the most likely failure. Mitigated in layers: tools over remembered commands, rejection of illegal transitions, and a tree check that flags unsupported claims. Enforcement narrows what a session can *do*; it does nothing about what a session *says* it did.
- **Two producers double the surface for run-state bugs** → Unchanged, and still the reason this is parked until M2.
- **Users read `hooks` as equivalent to `engine`** → The tier names are in run-state and in the viewer, but naming is weak protection. The concrete guard is that the absent guarantees are enumerated per tier in one place, so a run cannot display accounting or process-level claims it never had.
- **Host-specific enforcement makes "guest mode" mean different things per host** → Accepted deliberately. The alternative is levelling down to the weakest host, which would discard the enforcement this revision exists to claim.

## Migration Plan

Purely additive: no existing command, file format, or workflow changes behavior. `flow-code run` and `flow-code watch` are untouched, and run-state gains optional provenance and tier fields that older readers ignore. Rollback is removal of the new surfaces — existing runs and viewers are unaffected because nothing about the driver-mode path depends on them.

Sequencing note: this change assumes `flow-code watch`, which exists in the working tree but has no spec coverage (GAP-01). That gap should be closed before implementation, since the `terminal-canvas-ui` delta here builds on watch-mode requirements that are not yet written down.

## Open Questions

- How does the plugin *verify* its hooks are active before recording the `hooks` tier, rather than inferring it from its own installation? A self-test tool call that expects to be denied is the obvious shape, but it costs a round trip at run open and it is not obvious how often to repeat it.
- Does a guest run open against a fresh run id every session, or resume the project's most recent unfinished guest run? Resuming matches how people actually work across several sittings; a fresh run per session is simpler and never merges two agents' claims.
- Which node types count as "expected to modify the repository" for reconciliation? Derivable from the node type's capability set, but `git-ops` and gate-style nodes need a deliberate answer.
- Should the CLI surface be `flow-code node <id> start|done|fail` or a single `flow-code report` verb? The former reads better in instructions; the latter is easier to keep in lockstep with the MCP tool list.
- The capability names still say `guest`, which fit when the premise was "flow-code is a guest in someone else's session with no rights." Under the tier model the primary surface is closer to a host-session harness. Renaming is churn against a parked change; deciding it at implementation time is cheap.
