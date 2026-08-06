## ADDED Requirements

### Requirement: Node sessions may delegate to subagents
A node's agent session SHALL be permitted to spawn subagents. The set of agent types it may spawn SHALL be supplied by flow-code as a closed registry compiled per node, and a request to spawn an agent type outside that registry SHALL be denied like any other unavailable tool.

#### Scenario: A node delegates part of its work
- **WHEN** an agent session belonging to a node spawns a subagent of a type in the node's compiled registry
- **THEN** the subagent SHALL run, and its tool calls SHALL be subject to the same capability harness as its parent's

#### Scenario: An agent type outside the registry is requested
- **WHEN** an agent session requests an agent type that flow-code did not compile into that node's registry
- **THEN** the request SHALL be denied and the denial SHALL be recorded in the node's activity log

#### Scenario: Runners without a subagent concept
- **WHEN** a node executes via a runner that has no subagent mechanism
- **THEN** the node SHALL run to completion with no subagents, and its behavior SHALL differ from the SDK-backed runner only in that respect

### Requirement: Subagents inherit their parent node's capability envelope
A subagent SHALL execute with exactly the capability set and working directory of the node that spawned it, enforced by the same per-tool-call interception as its parent. A subagent SHALL NOT hold any capability its parent node lacks. A compiled subagent definition MAY narrow the tools available to a subagent below its parent's set, and SHALL NOT widen them.

#### Scenario: Subagent attempts a capability its parent node lacks
- **WHEN** a subagent spawned by a Review node — whose capability set is read-only — attempts a file write or a shell command
- **THEN** the harness SHALL deny the call before it executes and return the denial to the subagent as a tool error

#### Scenario: Subagent attempts to leave the working directory
- **WHEN** a subagent attempts a file-reading or file-writing tool call resolving outside its parent node's working directory
- **THEN** the harness SHALL deny the call

#### Scenario: Subagent inherits a Worktree-Agent instance's directory
- **WHEN** a subagent is spawned by an agent session running inside a Worktree-Agent instance
- **THEN** its working directory SHALL be that instance's isolated worktree, not the repository root

#### Scenario: A denied subagent call does not fail the node
- **WHEN** the harness denies a subagent's tool call
- **THEN** the denial SHALL be recorded against the parent node and the node SHALL remain in its current status, exactly as for a denial in the parent's own session

### Requirement: Subagent work is attributed in the activity log
Every activity-log entry SHALL identify which agent within the node produced it. An entry produced by the node's own session SHALL be distinguishable from one produced by a subagent, and entries from two different subagents SHALL be distinguishable from each other.

#### Scenario: A subagent runs a tool
- **WHEN** a subagent executes a tool call
- **THEN** the appended activity entry SHALL record the subagent's identifier and its agent type, in addition to everything an entry already records

#### Scenario: The parent session runs a tool
- **WHEN** the node's own agent session executes a tool call
- **THEN** the appended activity entry SHALL carry no subagent identifier, marking it as the parent's

#### Scenario: Two subagents run concurrently
- **WHEN** a node has two subagents in flight and both execute tool calls
- **THEN** each entry SHALL carry the identifier of the subagent that produced it, so the two sequences remain separable

#### Scenario: Attribution survives without a UI
- **WHEN** a run executes with no terminal UI attached
- **THEN** attribution SHALL still be recorded in run-state, since it is produced by the harness rather than by the rendering layer

### Requirement: Subagent output does not become node output
A node's result SHALL be derived only from its own agent session's final response. Text produced by a subagent SHALL NOT be treated as the node's output, whether or not the underlying runner forwards subagent text on the session stream.

#### Scenario: A subagent produces text before the parent concludes
- **WHEN** a subagent emits assistant text and the parent session subsequently produces its own final response
- **THEN** the node's output SHALL be the parent's final response

#### Scenario: A node type that parses structured output
- **WHEN** a Validate or Review node — whose output is parsed as JSON — runs with subagents
- **THEN** the text parsed SHALL be the parent session's, so a subagent's prose cannot displace the node's verdict

### Requirement: Subagent sessions count against the concurrency cap
The configured maximum number of concurrently running agent sessions SHALL account for subagent sessions, not only node-level and Worktree-Agent-instance sessions. A spawn that would exceed the cap SHALL be refused rather than held, so that no session ever blocks awaiting a slot held by its own ancestor.

#### Scenario: A node's subagents would exceed the cap
- **WHEN** an agent session attempts to spawn a subagent and no concurrency allowance remains
- **THEN** the spawn SHALL be denied and returned to the session as a tool error naming the cap, and the session SHALL be free to do the work itself

#### Scenario: Fan-out multiplied by delegation
- **WHEN** several Worktree-Agent instances each spawn subagents
- **THEN** the total number of concurrently running sessions across instances and their subagents SHALL NOT exceed the cap

#### Scenario: A refused spawn does not stall its parent
- **WHEN** a spawn is refused for want of concurrency allowance
- **THEN** the refusal SHALL return immediately rather than blocking, and the parent session SHALL continue

#### Scenario: Allowance is returned when a subagent finishes
- **WHEN** a subagent reaches the end of its work
- **THEN** its allowance SHALL be released, and a subsequent spawn within the cap SHALL be permitted
