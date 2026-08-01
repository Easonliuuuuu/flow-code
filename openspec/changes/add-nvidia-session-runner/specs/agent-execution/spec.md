## MODIFIED Requirements

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
