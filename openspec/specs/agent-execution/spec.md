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
Every agent session SHALL be launched through a harness that compiles the node type's declared capability set into enforced session restrictions, regardless of which `SessionRunner` executes it. The harness SHALL apply, at minimum: a tool allow/deny list, a per-tool-call interception check that inspects the actual command or input before it executes, and a system-prompt statement of the boundary. Capability enforcement SHALL NOT depend on prompt instructions alone. The interception check SHALL apply to every tool call made within a node's execution, including calls made by a subagent the node's session spawned.

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

#### Scenario: A subagent's tool call is checked like its parent's
- **WHEN** a subagent spawned by a node's agent session attempts a tool call
- **THEN** the harness SHALL apply the interception check against the parent node's capability set and working directory, and SHALL deny the call if it falls outside them

#### Scenario: Unrecognized tools remain denied by default
- **WHEN** a tool call names a tool the harness does not classify under any capability
- **THEN** the harness SHALL deny it, so that permitting subagents does not widen the tool surface beyond what is explicitly classified

#### Scenario: Enforcement is equivalent across runners
- **WHEN** the same node type and capability set execute once via the Claude Agent SDK-backed runner and once via the NVIDIA-backed runner
- **THEN** both SHALL produce the same allow/deny outcome for the same attempted tool call or shell command, and both SHALL record the outcome as an activity-log entry in the same shape

#### Scenario: A runner without subagents is not weaker for lacking them
- **WHEN** a runner provides no subagent mechanism
- **THEN** the absence SHALL NOT constitute an enforcement difference, since every tool call such a runner makes is still checked against the same capability set

### Requirement: Node output contract
Every node type SHALL produce a structured output value conforming to its declared output schema, recorded in run-state and available to downstream nodes and to any Approval-Gate that depends on it. A node type MAY declare a failure predicate over its own recorded output; when the predicate holds, the node's terminal status SHALL be `error` rather than `done`.

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

#### Scenario: A failing verdict fails the node
- **WHEN** a Validate or Review node completes its session and its recorded output carries a `fail` verdict
- **THEN** the node's terminal status SHALL be `error`, its recorded output SHALL still be stored in full, and its status detail SHALL identify the verdict as the reason

#### Scenario: A passing verdict completes the node
- **WHEN** a node type declaring a failure predicate completes and its recorded output does not satisfy that predicate
- **THEN** the node's terminal status SHALL be `done`

#### Scenario: Failure predicate is declared by the type, not the edge
- **WHEN** a node type declares a failure predicate
- **THEN** that predicate SHALL be a property of the node type in the registry, and no edge in the workflow file SHALL be able to declare, override, or suppress it

### Requirement: Upstream output propagation
When a node starts, the system SHALL provide it with the recorded outputs of its direct upstream dependencies as part of its initial context. A node type MAY declare itself context-transparent; a context-transparent node SHALL forward the outputs of its own direct dependencies alongside its recorded output, so that inserting one into the graph does not sever the context chain.

#### Scenario: Implement node consumes the preceding discussion
- **WHEN** an Implement node whose only dependency is a Discuss node starts
- **THEN** that Discuss node's recorded output SHALL be present in the Implement node's initial context

#### Scenario: Node with multiple dependencies
- **WHEN** a node with more than one direct upstream dependency starts
- **THEN** the outputs of all of its direct dependencies SHALL be present in its initial context, each labelled with the node id that produced it

#### Scenario: Indirect ancestors are not propagated
- **WHEN** a node starts and the graph contains nodes that are ancestors but not direct dependencies, and no context-transparent node lies between them
- **THEN** those nodes' outputs SHALL NOT be injected into its context, so context growth is bounded by fan-in rather than by graph depth

#### Scenario: Context survives an Approval-Gate
- **WHEN** a node's only direct dependency is an Approval-Gate
- **THEN** that node's initial context SHALL contain both the gate's decision and the recorded outputs of the gate's own direct dependencies, each labelled with the node id that produced it

#### Scenario: Chained context-transparent nodes
- **WHEN** two context-transparent nodes are adjacent on the graph
- **THEN** forwarding SHALL compose through them, and each forwarded output SHALL appear at most once in the resulting context regardless of how many paths reach it

#### Scenario: Oversized upstream output
- **WHEN** an upstream node's recorded output exceeds the configured size limit for context injection
- **THEN** the system SHALL inject a truncated form marked as truncated, and the full output SHALL remain available in run-state

#### Scenario: Forwarding respects the size limit
- **WHEN** the combined forwarded context through a context-transparent node exceeds the configured size limit
- **THEN** the system SHALL truncate as it does for any oversized upstream output, and the full outputs SHALL remain available in run-state

### Requirement: Tool-call activity log
Every node execution SHALL record an append-only activity log of the tool calls it attempts. Each entry SHALL include a timestamp, the tool name, the command string or an input summary, the harness permission decision, and — for calls that executed — the duration and exit status or error. Each entry SHALL also identify which agent within the node produced it, so that concurrent agents under one node remain separable.

#### Scenario: Agent runs a shell command
- **WHEN** an agent session belonging to a node executes a shell command
- **THEN** the system SHALL append an entry recording the timestamp, the tool name, the full command string, the `allowed` decision, the elapsed duration, and the command's exit status

#### Scenario: Harness denies a command
- **WHEN** the harness denies a tool call
- **THEN** the system SHALL append an entry recording the timestamp, the tool name, the attempted command or input, the `denied` decision, and the capability that was missing

#### Scenario: Entry identifies the agent that produced it
- **WHEN** any tool call is recorded for a node that ran subagents or fanned out into several Worktree-Agent instances
- **THEN** the entry SHALL carry enough attribution to tell which agent produced it, and an entry from the node's own session SHALL be distinguishable from a subagent's

#### Scenario: Activity log persists across a crash
- **WHEN** flow-code exits unexpectedly mid-run
- **THEN** the activity log entries written before the exit SHALL be present in the persisted run-state file for that run

#### Scenario: Entries written before attribution existed
- **WHEN** a run-state file written by an earlier version is read
- **THEN** its activity entries SHALL remain readable and SHALL be treated as produced by the node's own session

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
The system SHALL enforce a maximum number of concurrently running agent sessions across a run, configurable via the workflow file's `settings` block and defaulting to a low value. Every agent session SHALL be counted against the cap, including subagent sessions spawned within a node.

#### Scenario: Fan-out exceeds concurrency cap
- **WHEN** more Worktree-Agent instances become ready than the configured concurrency cap allows
- **THEN** the system SHALL queue the excess instances and start them only as running sessions complete, never exceeding the cap

#### Scenario: Subagents exceed concurrency cap
- **WHEN** an agent session attempts to spawn a subagent that would take the number of concurrently running sessions past the cap
- **THEN** the spawn SHALL be denied and returned to the session as a tool error, rather than held until a slot frees

#### Scenario: A refused spawn does not stall its parent
- **WHEN** a spawn is refused for want of concurrency allowance while the session that attempted it holds a slot
- **THEN** the refusal SHALL return immediately, so no session ever waits on a slot held by its own ancestor

### Requirement: Discuss node interactive sub-panel
The Discuss node type SHALL open an interactive sub-panel for direct back-and-forth with the user, holding that node at `waiting` until the user explicitly signals the discussion is done. No other node SHALL be started while a Discuss node is active; nodes already running SHALL be allowed to finish.

#### Scenario: User is mid-discussion
- **WHEN** a Discuss node is active and the user has not yet signaled completion
- **THEN** the node's status SHALL remain `waiting` and no downstream node SHALL start

#### Scenario: Another node is already running when Discuss becomes active
- **WHEN** a Discuss node becomes active while another node is `running`
- **THEN** the running node SHALL be allowed to run to completion, and no additional node SHALL be started until the discussion is signalled complete

### Requirement: Loop-back re-execution
When a node fails and a loop-back edge declares that node as its source, the system SHALL reset the loop-back target and every node on a path from that target to the source, then re-execute that segment rather than terminating the run.

#### Scenario: A failed verification returns to implementation
- **WHEN** a Validate node fails and a loop-back edge is declared from that Validate node to an upstream Implement node
- **THEN** the system SHALL reset the Implement node and every node between it and the Validate node to `idle`, and SHALL re-run that segment

#### Scenario: Nodes outside the loop segment are untouched
- **WHEN** a loop-back resets a segment
- **THEN** nodes that are not on any path from the loop-back target to the failing node SHALL retain their recorded status and output, and nodes downstream of the failing node SHALL remain unstarted rather than `skipped`

#### Scenario: Reset clears node results
- **WHEN** a node is reset by a loop-back
- **THEN** its recorded output, status detail, and streamed live output SHALL be cleared for the new attempt, and its accumulated activity log SHALL be retained

#### Scenario: The retried segment learns why it failed
- **WHEN** a loop-back target is re-executed
- **THEN** its initial context SHALL include the recorded output and status detail of the node that triggered the loop-back, labelled as the reason for the retry

#### Scenario: Loop-back after a rejected gate
- **WHEN** an Approval-Gate is rejected and a loop-back edge declares that gate as its source
- **THEN** the system SHALL reset and re-run the loop-back segment instead of marking the downstream nodes `skipped`

### Requirement: Bounded loop attempts
Every loop-back SHALL be bounded by a maximum attempt count, and the run SHALL terminate rather than loop indefinitely when that bound is reached.

#### Scenario: Attempt limit is reached
- **WHEN** a loop-back has re-run its segment up to its declared maximum attempts and the source node fails again
- **THEN** the system SHALL NOT loop again, SHALL leave the source node in `error`, SHALL mark its downstream nodes `skipped`, and SHALL report that the attempt limit was the reason

#### Scenario: Attempts are recorded per node
- **WHEN** a node has been executed more than once because of a loop-back
- **THEN** run-state SHALL record the number of attempts that node has taken and the terminal status of each prior attempt

#### Scenario: A run with loop-backs still terminates
- **WHEN** a workflow declares one or more loop-back edges
- **THEN** every run of that workflow SHALL reach a terminal state in a bounded number of node executions

#### Scenario: Success resets nothing
- **WHEN** a re-run segment completes and the previously failing node succeeds
- **THEN** execution SHALL continue to that node's downstream nodes normally, and the recorded attempt history SHALL be retained

### Requirement: Skill text is composed behind the capability boundary
When a node has resolved skills attached, the system SHALL compose their text into the session's system prompt ahead of the node type's role prompt and ahead of the capability boundary statement, so the boundary is stated last and the skill cannot present itself as overriding it. The compiled tool policy SHALL be derived from the node type's capability set alone and SHALL be unaffected by attached skills.

#### Scenario: A node with skills starts a session
- **WHEN** the system builds a session request for a node with attached skills
- **THEN** the system prompt SHALL contain the composed skill text, then the node type's role prompt, then the capability boundary statement

#### Scenario: The tool policy is independent of skills
- **WHEN** the tool policy is compiled for a node with attached skills
- **THEN** the resulting allowed and denied tool sets SHALL be identical to those compiled for the same node type with no skills attached

#### Scenario: Skill composition is runner-independent
- **WHEN** a session request carrying composed skill text is executed
- **THEN** every `SessionRunner` implementation SHALL deliver that text to its provider through the same field it uses for the role prompt, with no runner-specific skill handling

### Requirement: A node's skills are visible during and after the run
The system SHALL record which skills a node ran with, and SHALL surface them in that node's detail view alongside its output and activity log, so an observer can attribute the node's behavior to the instructions it was given.

#### Scenario: Inspecting a node that carried skills
- **WHEN** the user opens the detail view of a node with attached skills
- **THEN** the system SHALL show the identifiers of the skills that node ran with

#### Scenario: A skill's instructions are denied a tool
- **WHEN** a tool call originating from a skill's instructions is denied by the harness
- **THEN** the denial SHALL be recorded in the node's activity log with the same shape as any other denied call

### Requirement: Unmet output contracts distinguish their cause
When an agent-driven node's session terminates without producing output conforming to its type's output schema, the system SHALL classify the failure and report the cause in the node's status detail, distinguishing at least a session that ended by requesting user input from output that was produced but did not conform to the schema.

#### Scenario: The session ended by asking a question
- **WHEN** a non-interactive node's session produces no conforming output and its final response requests input from the user
- **THEN** the node SHALL reach `error` with a status detail stating that the session ended by asking a question and that the node is non-interactive

#### Scenario: The session produced malformed output
- **WHEN** a node's session produces a response that is not valid output for its type's schema and is not a request for user input
- **THEN** the node SHALL reach `error` with a status detail identifying the schema violation

#### Scenario: The full response is retained either way
- **WHEN** a node fails for either cause
- **THEN** the session's final response SHALL be retained in the node's recorded output or streamed output, so the user can read what the session actually said
