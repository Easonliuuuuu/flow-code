## Context

flow-code is a new, greenfield terminal application. There's no existing tool that renders an agentic coding task's lifecycle as a live, interactive node graph in the terminal — the closest prior art (n8n, LangGraph Studio) is web-canvas based, and the closest terminal-native tools (Claude Code's Agent View, Conductor, Crystal) render a flat session list, not a graph. This design covers the core engine: the workflow graph model, the terminal rendering approach, how nodes actually execute agent work, and how each node's permissions are enforced.

## Goals / Non-Goals

**Goals:**
- Render a coding workflow as an interactive node graph directly in the terminal (boxes, edges, live status, mouse click/drag).
- Let a project define its own graph (which built-in node types, how connected, config) via a checked-in workflow file — no custom code required.
- Drive each node's actual agent work via the Claude Agent SDK directly, not by wrapping an interactive `claude` session.
- Make each node's permissions structural: a node type's capability set is enforced at the tool-call level, not asked for in a prompt.
- Make every command an agent runs visible and auditable per node.
- Support parallel execution of multiple isolated agents in separate `git worktree`s (Worktree-Agent node).
- Make git-mutating transitions explicit and blockable via an Approval-Gate node (diff shown, user approves inline before anything is pushed/merged).

**Non-Goals (deferred to later changes):**
- A general plugin API for fully custom (user-authored) node executors — v1 ships a fixed palette of built-in types; only the graph composition is user-configurable.
- Per-node cost/token telemetry, flow-as-audit-trail history across runs, and time-travel replay. (The per-node *activity log* is in scope; aggregated cost/time reporting is not.)
- Re-running or resuming an individual node after it errors. A failed run is re-run from the start in v1.
- Resuming an interrupted run from persisted run-state. Run-state persistence in v1 exists for worktree reconciliation and the activity log, not for resume.
- Multi-user/hosted/shared deployment — v1 is a local CLI tool run per-developer, per-repo.

## Decisions

**Runtime: TypeScript on Node.js.** Matches the Claude Agent SDK's primary SDK, npm distribution (`npx flow-code`), and the existing terminal-tooling ecosystem. Alternative considered: Python (Textual has a very mature TUI story) — rejected because the Claude Agent SDK and worktree/git tooling integration is more natural in the JS/TS ecosystem flow-code is being distributed into.

**Workflow definition: a YAML file at `.flow-code/workflow.yaml`, checked into the target repo.** It declares `settings` (run-wide config: concurrency cap, default model), `nodes` (id, type, config), and `edges` (from, to). Each built-in node type owns a config schema (validated with `zod`) so a malformed workflow file fails fast with a specific error, not a runtime crash mid-run. `flow-code init` scaffolds a default workflow (Discuss → Implement → Test → Validate → Review → Approval-Gate → Git-ops) so zero-config use works immediately.

**Node types are defined by a triple: (capability set, default role prompt, output schema).** Without this, the eight built-in types would all reduce to "run an agent session with different instructions" and the registry would be cosmetic. The capability set is what makes them structurally different and is enforced by the harness below:

| Type | Capabilities | Notes |
|---|---|---|
| Discuss | `read` + interactive | No mutation; conversation only |
| Implement | `read`, `edit`, `exec` | No git-write |
| Test | `read`, `exec` | **No agent session** — runs configured commands deterministically |
| Validate | `read`, `exec` | No `edit`: a conformance check must not be able to edit its way to passing |
| Review | `read` | Critique only; no edit, no exec |
| Git-ops | `read`, `git-read`, `git-write` | No `edit`: it commits and pushes what exists, it doesn't author changes |
| Worktree-Agent | per-instance, same as Implement | Scoped to its own worktree |
| Approval-Gate | none | No agent session; computes a diff and waits |

Test/Validate/Review are three genuinely different executors, not three prompts: Test is deterministic commands with no LLM and no API cost, Validate is an agent checking work against the task's intent, Review is an agent critiquing quality.

**No network capability in v1.** The vocabulary is deliberately `read`, `edit`, `exec`, `git-read`, `git-write` — there is no `net`. No built-in type needs it, and an unused capability in the vocabulary is an invitation to grant it casually later. Network tools are simply unavailable to every session. Add it when a type has a concrete reason, and give that reason a spec.

**Git-ops config is explicit, and pushing is opt-in.** "Has `git-write`" is a permission, not a behavior. The type's config declares whether it commits only or also pushes, and to which remote and branch; a push node with no remote fails validation at load time rather than at the moment of pushing. A gate upstream of a push-configured Git-ops node states the push target in its detail view, so the user approving a diff also knows where it is going.

**Capability harness: three layers, only one of which is real enforcement.** (1) The system prompt states the boundary — improves behavior, guarantees nothing. (2) The Agent SDK's tool allow/deny list handles coarse cuts (a Review node gets no file-writing tools at all). (3) A per-tool-call interception callback inspects the actual input before execution — this is the only layer that can distinguish `git push` from `git log`, because both arrive as the same shell tool. The harness compiles a node's capability set into all three, plus a working-directory scope.

Two properties matter beyond blocking: **denials are events, not silence** — a blocked `git push` renders on the graph, which is exactly the "risky actions should be visible" thesis in the proposal; and **the same interception point is the logging point**, so the activity log costs almost nothing once the harness exists.

**Honest limit:** shell-command inspection is a guardrail against a well-intentioned agent, not a sandbox against a hostile one — `eval`, `$(...)`, git aliases, or writing-then-running a script all defeat naive matching. As defense in depth, non-Git-ops sessions get `remote.origin.pushurl` set to an invalid value via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` env vars, which scopes to the child process only and never mutates the user's repo config.

**Node output contract.** Each type declares an output schema recorded in run-state: Discuss emits its conclusion and agreed constraints, Implement emits a diff and changed-file set, Test emits per-command exit statuses, Review emits a verdict plus findings, Worktree-Agent emits per-branch summaries. Without this there is nothing for an Approval-Gate to compute a diff *from*, and no basis for a future conditional edge — it is what makes this a graph rather than a linear script.

**Output propagation is direct dependencies only.** A starting node receives the recorded outputs of its immediate upstream dependencies, each labelled with the producing node id, injected into its initial context. Not transitive ancestors: propagating the whole ancestry would make context growth a function of graph depth, so a seven-node default chain would carry every earlier node's output into Git-ops. Fan-in bounds it instead. Oversized outputs (a large diff) are injected truncated with a marker, and the full value stays in run-state for the UI and the gate. This is the data-flow spine — Discuss → Implement is worthless if Implement cannot see what was agreed.

**Run baseline and preflight.** The run records a baseline before any node starts: the starting commit, plus a snapshot of uncommitted changes if the user passed the dirty-tree override. Every diff in the run — gates especially — is computed against that baseline. This exists because the headline guarantee breaks otherwise: with a dirty tree and a commit-only reference, the approval diff mixes the user's own uncommitted work into what reads as agent output, and the one screen the whole product asks the user to trust becomes misleading. Default is to refuse to start on a dirty tree; the override is explicit and changes the baseline rather than the diff semantics.

Preflight also resolves credentials and checks `git worktree` availability when the graph needs it. All three checks run before any node starts, so the failure mode is a clear message at second zero rather than a crash three nodes in with a worktree already created.

**Execution model: a DAG executor over the node graph, serialized on the shared working tree.** Nodes with satisfied dependencies run as soon as ready, but only one at a time when they operate on the repo's main checkout — two concurrent agent sessions editing the same files would corrupt each other's work. True concurrency exists only between Worktree-Agent instances, each of which owns an isolated directory, capped by the configured concurrency limit. Each node type implements `execute(context): AsyncIterator<StatusEvent>`; the engine consumes these events into a central state store. The terminal UI subscribes to that store and re-renders — the engine has no direct dependency on the rendering layer, so the graph can also run headless (e.g. in CI) later without UI changes.

**Approval-Gate as a node type, not an edge property.** The gate has a status, a detail view, a focus target, and a diff panel — all of which need a node id and a slot in the run-state store. An edge is a line; you cannot expand a line, and a fan-out node with three downstream edges, two gated, has no coherent single approval UI. So edges stay dumb (`from`, `to`) and gating is expressed by placing a gate node on the path. If author-side verbosity becomes a complaint, add `gate: true` as *load-time sugar* that desugars into an inserted gate node — one runtime concept, cheap authoring. Not in v1.

The gate's diff is defined concretely: the working tree of the gate's working directory versus the run baseline recorded in run-state.

**Worktree-Agent convergence produces a working directory.** Compare mode requires selecting exactly one branch; parallelize mode may select several, which are merged, and a merge conflict fails the node rather than being silently resolved. The converged directory is recorded in run-state and becomes the working directory for every downstream node — the selected worktree is retained until the run ends, and only the non-selected ones are cleaned up. Worktrees are tracked in run-state so `flow-code doctor` can reconcile orphans after a crash.

**Terminal rendering: Ink for component/state architecture, with a dedicated low-level layer for the actual node-canvas (absolute positioning, box/line drawing, mouse click-and-drag) underneath it.** Ink's React model is good for state-driven panels (node detail view, activity log, Discuss sub-panel, approval diff view) but isn't built for freeform 2D layout with mouse-dragged boxes. Layout is automatic (left-to-right, dependency order); dragged positions are session-only and never written back to the workflow file. The canvas layer is the highest-risk/least-proven part of this design — see Open Questions.

## Risks / Trade-offs

- **[Risk]** Mouse/canvas interactivity is inherently less consistent across terminal emulators than a browser canvas → **Mitigation:** keyboard navigation (tab between nodes, enter to expand/approve) is the primary, always-working interface; mouse is an enhancement, not a requirement.
- **[Risk]** The capability harness depends on the Claude Agent SDK exposing a per-tool-call interception hook with access to the raw tool input. If it does not, the git-write boundary cannot be enforced at all → **Mitigation:** confirm this API surface in the first spike, before building the node type registry on top of it. Fallback would be to route all shell execution through a flow-code-owned tool rather than the SDK's built-in one.
- **[Risk]** Shell-command inspection is bypassable by a determined agent (`eval`, subshells, aliases) → **Mitigation:** treat it as a guardrail, not a sandbox; layer the env-scoped `pushurl` block underneath; document the limit rather than overclaiming.
- **[Risk]** Serializing on the shared working tree makes the graph less parallel than it looks, which may disappoint users who expect branches to run at once → **Mitigation:** document that parallelism is a Worktree-Agent feature; the graph's value is visibility and gating, not raw concurrency.
- **[Risk]** Running several Worktree-Agent instances in parallel multiplies Claude API cost/rate-limit exposure → **Mitigation:** configurable concurrency cap in `settings`, defaulting low (e.g. 2–3 concurrent sessions).
- **[Risk]** Orphaned `git worktree`s if flow-code crashes or is killed mid-run → **Mitigation:** worktrees tracked in run-state (`.flow-code/runs/<run-id>.json`); `flow-code doctor` reconciles on next launch.
- **[Risk]** A new YAML workflow format is one more thing to learn → **Mitigation:** `flow-code init` ships a working default graph; most users never need to hand-edit it for the built-in-only v1.

## Migration Plan

Greenfield project — no existing users or data to migrate. `flow-code init` is the entry point: scaffolds `.flow-code/workflow.yaml` with the default graph including the Approval-Gate before Git-ops, so `flow-code run` works immediately after init.

## Open Questions

*(Resolved by the section-1 spikes — outcomes recorded below.)*

- **Canvas rendering approach** — RESOLVED: Ink 7 + a custom canvas layer. OpenTUI (0.4.x) is pre-1.0 on a native Zig core, which means per-platform binaries in an npm-distributed CLI. The canvas layer composes a character grid (boxes, box-drawing edges) rendered inside Ink, with SGR (1006) mouse events parsed from raw stdin via `useStdin`.
- **Agent SDK interception surface** — RESOLVED (verified against `@anthropic-ai/claude-agent-sdk` 0.3.220): `canUseTool(toolName, input, opts)` receives the raw tool input (full Bash command string) before execution; returning `{ behavior: 'deny', message }` surfaces the denial to the session as a recoverable tool error (only `interrupt: true` aborts). `allowedTools`/`disallowedTools`, per-session `cwd` (out-of-scope file access reaches `canUseTool` with a `blockedPath` hint), per-session `env` (enables the `GIT_CONFIG_COUNT` pushurl block), and plain-string `systemPrompt` all exist. The fallback (flow-code-owned shell tool) is not needed.
- **Discuss node UX** — split-pane: the graph stays visible beside the discussion panel, consistent with the node detail view's layout. (Modal overlay rejected: hiding the graph contradicts the visibility thesis.)
- **Activity log retention**: keep every tool call for the life of the run-state file in v1; revisit if run files grow problematic.
- **Upstream output size limit**: 16 KiB per upstream output on context injection; the truncated form clips (no summarization) and appends an explicit `[truncated: full output in run-state]` marker.
- **Config schema tooling** — RESOLVED: `zod` v4. Issue paths give node-id-scoped error messages directly.
