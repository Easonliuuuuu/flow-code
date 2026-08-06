## MODIFIED Requirements

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
