## 1. Spikes (do these before committing to the stack)

- [x] 1.1 Spike: confirm the Claude Agent SDK's per-tool-call interception surface — can we inspect a shell command before it executes, deny it, and return the denial to the session as a recoverable tool error? Confirm working-directory scoping and tool allow/deny lists. (Gates section 4; see design.md Open Questions)
- [x] 1.2 Spike: evaluate Ink + a custom absolute-positioned canvas layer vs. OpenTUI for node-graph rendering with mouse support; pick one
- [x] 1.3 Confirm config-schema library (`zod` or similar) for per-node-type validation and error messages

## 2. Project Setup

- [x] 2.1 Scaffold TypeScript/Node project with package.json, tsconfig, npm bin entry for `flow-code`
- [x] 2.2 Add Claude Agent SDK plus the dependencies chosen in section 1
- [x] 2.3 Set up build/lint/test tooling (e.g. tsup or tsc, vitest, eslint)

## 3. Workflow Graph Model

- [x] 3.1 Define the node type registry: each built-in type declares a capability set, a default role prompt, an output schema, and a config schema
- [x] 3.2 Implement `.flow-code/workflow.yaml` parser (`settings`, `nodes`, `edges`)
- [x] 3.3 Implement node type + per-node config validation against the registry, with node-id-scoped error messages
- [x] 3.4 Implement `settings` block validation (concurrency cap, default model) with documented defaults
- [x] 3.5 Implement graph structural validation (DAG check, dangling-edge check, reject unrecognized edge properties)
- [x] 3.6 Implement the Git-ops config schema (commit-only by default; push opt-in and requiring an explicit remote and branch, validated at load time)
- [x] 3.7 Implement `flow-code node-types` command listing each type's id, capabilities, config schema, and output shape

## 4. Capability Harness

- [x] 4.1 Define the capability vocabulary (`read`, `edit`, `exec`, `git-read`, `git-write` — no network capability in v1) and the per-type capability sets
- [x] 4.2 Implement compilation of a capability set into a tool allow/deny list plus a system-prompt boundary statement
- [x] 4.3 Implement the per-tool-call interception check, including the git-write command denylist for shell calls
- [x] 4.4 Implement working-directory scoping: deny file operations resolving outside the node's working directory
- [x] 4.5 Implement env-scoped `remote.origin.pushurl` block (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`) for non-Git-ops sessions as defense in depth
- [x] 4.6 Implement denial events: surface blocked calls to the run-state store rather than failing silently or aborting the node
- [x] 4.7 Tests: each node type's capability set is enforced — Implement cannot push, Review cannot edit, Validate cannot edit, Git-ops cannot edit

## 5. Activity Log

- [x] 5.1 Implement append-only per-node activity log entries (timestamp, tool, command/input summary, permission decision, duration, exit status) written from the interception point
- [x] 5.2 Persist activity log entries into `.flow-code/runs/<run-id>.json` as they occur, so they survive a crash
- [x] 5.3 Ensure the log is produced by the harness, not the UI, so headless runs record it too

## 6. DAG Execution Engine

- [x] 6.1 Implement central run-state store (node statuses: idle/running/waiting/done/error/skipped)
- [x] 6.2 Define `execute(context): AsyncIterator<StatusEvent>` contract shared by all node types
- [x] 6.3 Implement DAG executor: start nodes when dependencies are satisfied
- [x] 6.4 Implement serialization on the shared working tree: only one main-checkout node runs at a time; concurrency permitted only between Worktree-Agent instances
- [x] 6.5 Implement the configurable concurrency cap across running agent sessions
- [x] 6.6 Implement `skipped` propagation: mark all downstream nodes of an errored node or a rejected gate as `skipped`
- [x] 6.7 Implement run preflight: resolve credentials, check `git worktree` availability when the graph needs it, and refuse a dirty working tree unless the explicit override is passed
- [x] 6.8 Implement the run baseline (starting commit, plus a working-tree snapshot under the dirty-tree override) recorded before any node starts and used as the reference for every diff
- [x] 6.9 Implement run-state persistence (run id, baseline, node statuses, node outputs, worktrees, activity log)
- [x] 6.10 Implement node output recording against each type's output schema
- [x] 6.11 Implement upstream output propagation: inject direct dependencies' outputs (labelled by node id) into a starting node's context, truncating oversized values with a marker

## 7. Node Executors

- [x] 7.1 Implement the Agent SDK session wrapper: node config + role prompt + capability harness + working directory
- [x] 7.2 Implement agent-driven node executors: Implement, Validate, Review, Git-ops
- [x] 7.3 Implement the Test node executor as a deterministic command runner (no agent session, no API cost), recording per-command exit status and output
- [x] 7.4 Implement Discuss node's interactive sub-panel flow (holds at `waiting`, starts no new nodes, lets running nodes finish, resumes on explicit user completion signal) and record its conclusion/constraints as structured output
- [x] 7.5 Wire status event streaming from agent sessions into the run-state store

## 8. Terminal Canvas UI

- [x] 8.1 Implement graph auto-layout (left-to-right, dependency order)
- [x] 8.2 Implement node box + edge rendering with live status indicators for all six statuses, subscribed to the run-state store; render `skipped` distinctly from `idle`
- [x] 8.3 Implement keyboard navigation (tab between nodes, enter to expand/act) as the primary interaction path
- [x] 8.4 Implement viewport panning and focus-scrolls-into-view for graphs larger than the terminal
- [x] 8.5 Implement mouse click-to-focus and drag-to-reposition as an enhancement layer (session-only positions, never written back to the workflow file), with graceful no-mouse fallback
- [x] 8.6 Implement node detail view: status, config summary, live streamed output
- [x] 8.7 Implement the activity log panel in the node detail view (timestamp / tool / command / decision / exit status, appended live) plus a blocked-action indicator on the node box

## 9. Worktree-Agent Node

- [x] 9.1 Implement `git worktree add` fan-out (one worktree + branch per instance), each session scoped to its own directory
- [x] 9.2 Implement "compare" mode (same task, per-instance instruction/model overrides)
- [x] 9.3 Implement "parallelize" mode (distinct sub-task per instance)
- [x] 9.4 Implement convergence view (per-instance branch, diff summary, status) gating downstream start
- [x] 9.5 Implement selection semantics: compare mode selects exactly one branch; parallelize mode may select several and merges them
- [x] 9.6 Implement merge-conflict handling at convergence (node → `error`, report conflicting files, do not start downstream)
- [x] 9.7 Implement converged working-directory recording; downstream nodes run in it and the selected worktree is retained until the run ends
- [x] 9.8 Implement cleanup of non-selected worktrees, and orphaned-worktree reconciliation on launch
- [x] 9.9 Implement `flow-code doctor` cleanup command for orphaned worktrees

## 10. Approval-Gate Node

- [x] 10.1 Implement the Approval-Gate node type (no agent session; renders, focuses, and holds status like any node)
- [x] 10.2 Implement diff computation at gate time: working tree of the gate's working directory vs. the run baseline, plus upstream node output summaries
- [x] 10.2a Surface the push target (remote and branch) in the gate detail view when a push-configured Git-ops node is downstream
- [x] 10.3 Implement diff computation when upstream is a Worktree-Agent convergence (per selected branch, labelled)
- [x] 10.4 Implement approve/reject interaction (keyboard-first, mouse optional) blocking/unblocking downstream nodes
- [x] 10.5 Implement reject behavior: gate → `error`, all downstream nodes → `skipped`, independent branches unaffected

## 11. CLI & Default Workflow

- [x] 11.1 Implement `flow-code init` (scaffold default workflow, no-op with message if one exists)
- [x] 11.2 Implement default workflow template: Discuss → Implement → Test → Validate → Review → Approval-Gate → Git-ops
- [x] 11.3 Implement `flow-code run` entry point wiring graph load → executor → UI
- [x] 11.4 End-to-end test: run the default workflow against a sample repo through all node types, including a rejected gate path and a capability denial appearing in the activity log
