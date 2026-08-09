## ADDED Requirements

### Requirement: MCP server exposes driver-mode run lifecycle
The system SHALL provide an MCP server (`flow-code mcp`) exposing tools to start a run, query its state, respond to a node awaiting input, and stop a run, backed by the same `Engine` and workflow the `flow-code run` CLI uses.

#### Scenario: Starting a run over MCP
- **WHEN** an MCP host calls the start-run tool against a repository with a valid `.flow-code/workflow.yaml`
- **THEN** the system SHALL construct and run the same `Engine` the CLI would construct for `flow-code run`, writing to the same `.flow-code/runs/<runId>.json` document

#### Scenario: No workflow configured
- **WHEN** an MCP host calls the start-run tool against a repository with no `.flow-code/workflow.yaml`
- **THEN** the system SHALL return a tool error naming the missing file and SHALL NOT start a run

### Requirement: MCP-driven execution enforces the same harness as the CLI
A run started over MCP SHALL be subject to the identical capability scoping, command interception, and git-write gating as a run started from the CLI, with no reduction in enforcement.

#### Scenario: A node's tool policy is unchanged by entry point
- **WHEN** the same workflow is run once via `flow-code run` and once via the MCP start-run tool
- **THEN** each node SHALL be compiled with the identical tool policy in both runs, and neither run SHALL grant a capability the other denies

#### Scenario: Git-ops still requires an upstream gate decision
- **WHEN** a run started over MCP reaches a Git-ops node whose upstream Approval-Gate has not been approved
- **THEN** the system SHALL NOT execute the Git-ops node, identically to a CLI-driven run

### Requirement: Run state is queryable without polling
The system SHALL provide a tool to retrieve the current run state, and SHALL push node-transition events as MCP progress notifications for a run this server process started, without requiring the caller to poll.

#### Scenario: Querying a live run this process started
- **WHEN** an MCP host calls the get-run-state tool while this server process holds the run's live state
- **THEN** the system SHALL return current per-node status, the workflow's graph edges, and the reason for the most recent transition, read from the in-memory run state

#### Scenario: Querying a run started elsewhere
- **WHEN** an MCP host calls the get-run-state tool for a run this server process did not start
- **THEN** the system SHALL read the run's persisted state from `.flow-code/runs/` and return the same shape of response, falling back to file-based reading rather than failing

#### Scenario: Progress without polling
- **WHEN** a run started via the start-run tool transitions a node's status
- **THEN** the system SHALL emit an MCP progress notification for that transition before the start-run tool call resolves

### Requirement: Discuss and Approval-Gate are answerable through MCP tool calls
When a run started or observed over MCP reaches a node awaiting interactive input — an Approval-Gate awaiting a decision or a Discuss node awaiting the next message — the system SHALL provide a tool for the MCP host to supply that input, and SHALL resume the node's execution identically to the equivalent terminal interaction.

#### Scenario: Approving a gate over MCP
- **WHEN** a run's Approval-Gate node reaches status `waiting` and an MCP host calls the respond tool with an approve decision for that node
- **THEN** the system SHALL resolve the gate's pending approval request with `approve`, exactly as a keyboard approval would

#### Scenario: Rejecting a gate over MCP
- **WHEN** a run's Approval-Gate node reaches status `waiting` and an MCP host calls the respond tool with a reject decision for that node
- **THEN** the system SHALL resolve the gate's pending approval request with `reject`, halt that branch, and mark downstream nodes `skipped`, exactly as a keyboard rejection would

#### Scenario: Continuing a Discuss node over MCP
- **WHEN** a run's Discuss node is awaiting the next user message and an MCP host calls the respond tool with a message for that node
- **THEN** the system SHALL deliver that message as the Discuss node's next user message and continue the discussion

#### Scenario: Responding to the wrong node
- **WHEN** an MCP host calls the respond tool naming a node id that is not currently awaiting input
- **THEN** the system SHALL return a tool error naming the node's actual status and SHALL NOT alter run state

### Requirement: MCP-driven runs remain interoperable with the CLI
A run started via the MCP server SHALL be inspectable by `flow-code watch` and resumable by `flow-code run --resume`, and a run started by the CLI SHALL be inspectable via the get-run-state tool, without either surface treating the other's runs as second-class.

#### Scenario: Inspecting an MCP-started run from the terminal
- **WHEN** a run is started via the MCP server and is still in progress
- **THEN** `flow-code watch` SHALL attach to it and render its state exactly as it would a CLI-started run

#### Scenario: Inspecting a CLI-started run from MCP
- **WHEN** a run is started via `flow-code run` and is still in progress
- **THEN** the get-run-state tool SHALL return its state when queried, without requiring the run to have been started via MCP
