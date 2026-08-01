# agent-execution Specification

## Purpose

Defines how the run executes: preflight checks and the run baseline, Claude Agent SDK-driven node execution behind a capability-enforcing harness, node output contracts and upstream propagation, activity logging, status event streaming, and the concurrency rules governing the shared working tree and parallel sessions.

## Requirements

### Requirement: Run preflight checks
Before starting any node, the system SHALL verify that the environment can support the run and SHALL fail with a specific, actionable message rather than failing partway through execution.

#### Scenario: Credentials are unavailable
- **WHEN** the user starts a run and no Claude Agent SDK credentials can be resolved
- **THEN** the system SHALL fail before starting any node, naming credentials as the reason, and SHALL NOT have created any worktree or modified the repository

#### Scenario: NVIDIA credentials are unavailable
- **WHEN** the loaded workflow contains at least one agent-driven node type other than Discuss (which routes to the NVIDIA-backed runner) and no `NVIDIA_API_KEY` environment variable is set
- **THEN** the system SHALL fail before starting any node, naming `NVIDIA_API_KEY` as the missing credential, and SHALL NOT have created any worktree or modified the repository

#### Scenario: Git worktree support is unavailable
- **WHEN** the loaded workflow contains a Worktree-Agent node and the environment does not support `git worktree`
- **THEN** the system SHALL fail before starting any node with an error naming the missing capability

#### Scenario: Working tree is dirty at run start
- **WHEN** the user starts a run in a repository with uncommitted changes and has not passed an explicit override
- **THEN** the system SHALL refuse to start, explaining that pre-existing changes would be indistinguishable from agent changes in approval diffs

#### Scenario: Dirty working tree is explicitly allowed
- **WHEN** the user starts a run with the explicit dirty-tree override
- **THEN** the system SHALL record a baseline snapshot of the working tree as it exists at run start, and every subsequent diff SHALL be computed against that baseline so pre-existing changes do not appear as agent output

### Requirement: Run baseline
The system SHALL record a run baseline in run-state at run start — the starting commit, plus a snapshot of uncommitted changes when the dirty-tree override was used — and SHALL use it as the reference point for every diff computed during the run.

#### Scenario: Baseline recorded at run start
- **WHEN** a run begins
- **THEN** run-state SHALL contain the baseline before any node starts, and the baseline SHALL NOT change for the remainder of the run

### Requirement: Claude Agent SDK-driven node execution
The system SHALL execute each agent-driven node type by routing it, based on node type, to one of two `SessionRunner` implementations: the Discuss node type SHALL route to a Claude Agent SDK session; the Implement, Validate, Review, Git-ops, and Worktree-Agent node types SHALL route to an NVIDIA NIM API-backed session. Every session, regardless of which runner executes it, SHALL be scoped to that node's config and working directory, rather than shelling out to an interactive CLI session.

#### Scenario: Implement node runs
- **WHEN** the DAG executor starts an Implement node whose dependencies are satisfied
- **THEN** the system SHALL start an agent session via that node type's routed runner, with that node type's role prompt, the node's configured instructions, and the node's working directory as its working root, and mark the node `running`

#### Scenario: Discuss routes to the Claude Agent SDK
- **WHEN** the DAG executor starts a Discuss node
- **THEN** the system SHALL open the interactive session via the Claude Agent SDK-backed runner, regardless of whether `NVIDIA_API_KEY` is set

#### Scenario: Non-Discuss agent nodes route to the NVIDIA-backed runner
- **WHEN** the DAG executor starts an Implement, Validate, Review, Git-ops, or Worktree-Agent-instance node
- **THEN** the system SHALL run its session via the NVIDIA NIM API-backed runner, using that node's configured model or, if unset, the run's default model, or, if that is also unset, the runner's built-in default model

### Requirement: Capability harness enforces node permissions
Every agent session SHALL be launched through a harness that compiles the node type's declared capability set into enforced session restrictions, regardless of which `SessionRunner` executes it. The harness SHALL apply, at minimum: a tool allow/deny list, a per-tool-call interception check that inspects the actual command or input before it executes, and a system-prompt statement of the boundary. Capability enforcement SHALL NOT depend on prompt instructions alone.

#### Scenario: Node without the edit capability attempts a file write
- **WHEN** an agent session belonging to a node type whose capability set omits `edit` attempts a file-writing tool call
- **THEN** the harness SHALL deny the call before it executes and return the denial to the agent session as a tool error

#### Scenario: Node without git-write attempts to push
- **WHEN** an agent session belonging to a node type whose capability set omits `git-write` attempts a shell command that pushes, commits, merges, resets, or force-deletes in git
- **THEN** the harness SHALL deny the command before it executes, and the working tree and remote SHALL be unmodified by that call

#### Scenario: Denied action is surfaced, not silent
- **WHEN** the harness denies any tool call
- **THEN** the system SHALL emit an event recording the denial against that node, and the node SHALL remain in its current status rather than failing the run

#### Scenario: Sessions are scoped to their working directory
- **WHEN** any agent session is started
- **THEN** its working directory SHALL be set to the working directory assigned to that node, and file-reading and file-writing tool calls resolving outside that directory SHALL be denied

#### Scenario: Network tools are unavailable
- **WHEN** any agent session is started
- **THEN** network-capable tools SHALL NOT be available to it, since no built-in node type grants network access in this version

#### Scenario: Enforcement is equivalent across runners
- **WHEN** the same node type and capability set execute once via the Claude Agent SDK-backed runner and once via the NVIDIA-backed runner
- **THEN** both SHALL produce the same allow/deny outcome for the same attempted tool call or shell command, and both SHALL record the outcome as an activity-log entry in the same shape

### Requirement: Node output contract
Every node type SHALL produce a structured output value conforming to its declared output schema, recorded in run-state and available to downstream nodes and to any Approval-Gate that depends on it.

#### Scenario: Implement node produces a diff
- **WHEN** an Implement node reaches `done`
- **THEN** its recorded output SHALL include the set of changed files and the diff produced during its execution

#### Scenario: Review node produces a verdict
- **WHEN** a Review node reaches `done`
- **THEN** its recorded output SHALL include a pass/fail verdict and a list of findings, each with a location and a description

#### Scenario: Test node produces per-command results
- **WHEN** a Test node finishes
- **THEN** its recorded output SHALL include, for each configured command, the command string, its exit status, and its captured output

#### Scenario: Discuss node produces a conclusion
- **WHEN** a Discuss node reaches `done`
- **THEN** its recorded output SHALL include the conclusion reached and any constraints or decisions agreed during the discussion, in a form a downstream node can consume without replaying the transcript

### Requirement: Upstream output propagation
When a node starts, the system SHALL provide it with the recorded outputs of its direct upstream dependencies as part of its initial context.

#### Scenario: Implement node consumes the preceding discussion
- **WHEN** an Implement node whose only dependency is a Discuss node starts
- **THEN** that Discuss node's recorded output SHALL be present in the Implement node's initial context

#### Scenario: Node with multiple dependencies
- **WHEN** a node with more than one direct upstream dependency starts
- **THEN** the outputs of all of its direct dependencies SHALL be present in its initial context, each labelled with the node id that produced it

#### Scenario: Indirect ancestors are not propagated
- **WHEN** a node starts and the graph contains nodes that are ancestors but not direct dependencies
- **THEN** those nodes' outputs SHALL NOT be injected into its context, so context growth is bounded by fan-in rather than by graph depth

#### Scenario: Oversized upstream output
- **WHEN** an upstream node's recorded output exceeds the configured size limit for context injection
- **THEN** the system SHALL inject a truncated form marked as truncated, and the full output SHALL remain available in run-state

### Requirement: Tool-call activity log
Every node execution SHALL record an append-only activity log of the tool calls it attempts. Each entry SHALL include a timestamp, the tool name, the command string or an input summary, the harness permission decision, and — for calls that executed — the duration and exit status or error.

#### Scenario: Agent runs a shell command
- **WHEN** an agent session belonging to a node executes a shell command
- **THEN** the system SHALL append an entry recording the timestamp, the tool name, the full command string, the `allowed` decision, the elapsed duration, and the command's exit status

#### Scenario: Harness denies a command
- **WHEN** the harness denies a tool call
- **THEN** the system SHALL append an entry recording the timestamp, the tool name, the attempted command or input, the `denied` decision, and the capability that was missing

#### Scenario: Activity log persists across a crash
- **WHEN** flow-code exits unexpectedly mid-run
- **THEN** the activity log entries written before the exit SHALL be present in the persisted run-state file for that run

#### Scenario: Activity log is available without a UI
- **WHEN** a run executes with no terminal UI attached
- **THEN** the activity log SHALL still be recorded in run-state, since it is produced by the harness rather than by the rendering layer

### Requirement: Status event streaming
Every node execution SHALL emit a stream of status events drawn from `idle`, `running`, `waiting`, `done`, `error`, and `skipped`, consumed by a central state store independent of whether a UI is attached.

#### Scenario: Node completes successfully
- **WHEN** a node's execution finishes without error
- **THEN** the system SHALL emit a `done` status event and unblock any downstream nodes whose only dependency was this node

#### Scenario: Node execution errors
- **WHEN** a node's execution raises an unrecoverable error
- **THEN** the system SHALL emit an `error` status event, halt that node, and SHALL NOT start downstream nodes that depend on it

#### Scenario: Downstream of a halted node
- **WHEN** a node reaches `error` or its upstream Approval-Gate is rejected
- **THEN** every node downstream of it SHALL be set to `skipped` rather than left in `idle`, so the UI can distinguish "will not run" from "not yet started"

### Requirement: Serialized execution on the shared working tree
Nodes that operate on the repository's main working tree SHALL run one at a time. Concurrent execution SHALL be permitted only between Worktree-Agent instances, each of which owns an isolated working directory.

#### Scenario: Two independent branches both become ready
- **WHEN** two nodes on independent graph branches both have satisfied dependencies and both operate on the main working tree
- **THEN** the system SHALL start only one of them and queue the other until the first reaches a terminal status

#### Scenario: Worktree instances run concurrently
- **WHEN** a Worktree-Agent node fans out multiple instances, each with its own git worktree
- **THEN** those instances MAY run concurrently, subject to the configured concurrency cap

### Requirement: Concurrency cap for parallel sessions
The system SHALL enforce a maximum number of concurrently running agent sessions across a run, configurable via the workflow file's `settings` block and defaulting to a low value.

#### Scenario: Fan-out exceeds concurrency cap
- **WHEN** more Worktree-Agent instances become ready than the configured concurrency cap allows
- **THEN** the system SHALL queue the excess instances and start them only as running sessions complete, never exceeding the cap

### Requirement: Discuss node interactive sub-panel
The Discuss node type SHALL open an interactive sub-panel for direct back-and-forth with the user, holding that node at `waiting` until the user explicitly signals the discussion is done. No other node SHALL be started while a Discuss node is active; nodes already running SHALL be allowed to finish.

#### Scenario: User is mid-discussion
- **WHEN** a Discuss node is active and the user has not yet signaled completion
- **THEN** the node's status SHALL remain `waiting` and no downstream node SHALL start

#### Scenario: Another node is already running when Discuss becomes active
- **WHEN** a Discuss node becomes active while another node is `running`
- **THEN** the running node SHALL be allowed to run to completion, and no additional node SHALL be started until the discussion is signalled complete
