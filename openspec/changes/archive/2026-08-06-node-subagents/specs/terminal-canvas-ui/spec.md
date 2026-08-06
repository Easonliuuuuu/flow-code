## MODIFIED Requirements

### Requirement: Node detail view
The system SHALL provide an expandable detail view per node showing its current status, config summary, the model it resolves to, live streamed output, and its tool-call activity log. When a node ran more than one agent — subagents, or Worktree-Agent instances — the activity log SHALL be presented so that each agent's calls are attributable rather than interleaved into a single undifferentiated sequence.

#### Scenario: Expanding a running node
- **WHEN** the user expands a node that is currently `running`
- **THEN** the system SHALL display that node's live streamed output in the detail view, updating as new output arrives

#### Scenario: Viewing what the agent actually ran
- **WHEN** the user expands any node that has executed tool calls
- **THEN** the detail view SHALL show that node's activity log — one row per tool call with its timestamp, tool name, command or input summary, permission decision, and exit status — appended live as new calls occur

#### Scenario: A node that ran several agents
- **WHEN** the user expands a node whose activity log contains entries from more than one agent
- **THEN** the detail view SHALL make each row's originating agent identifiable, so two concurrent agents' sequences can be told apart

#### Scenario: A node that ran exactly one agent
- **WHEN** the user expands a node whose every entry came from its own session
- **THEN** the detail view SHALL NOT spend panel width on attribution that would distinguish nothing

#### Scenario: Denied action is visible in the node
- **WHEN** the capability harness denies a tool call for a node
- **THEN** that denial SHALL appear in the node's activity log marked as denied, naming the missing capability, and the node SHALL carry a visible indicator that at least one action was blocked

#### Scenario: Seeing which model a node runs on
- **WHEN** the user expands an agent-driven node
- **THEN** the detail view SHALL name the model that node resolves to and where that model came from

#### Scenario: Output line wider than the panel
- **WHEN** a node's streamed output contains a line wider than the detail panel's inner width
- **THEN** the system SHALL wrap that line onto further rows so its full text is readable, rather than cutting it off at the panel's right edge

## ADDED Requirements

### Requirement: Delegation is visible on the node card
A node running subagents SHALL indicate as much on its card while it runs, so that a node delegating work is distinguishable from one working alone without opening its detail view. The workflow graph itself SHALL continue to show exactly one box per workflow node; subagents SHALL NOT be rendered as nodes on the canvas.

#### Scenario: A node is running subagents
- **WHEN** a node has one or more subagents in flight
- **THEN** its card SHALL show how many, alongside the indicators it already carries

#### Scenario: Subagents do not become graph nodes
- **WHEN** a node spawns any number of subagents
- **THEN** the canvas SHALL still render one box for that node, and the graph's shape SHALL be unchanged from the workflow the user authored

#### Scenario: Card too small for the indicator
- **WHEN** the card is drawn at a density that has no room for the delegation indicator
- **THEN** the indicator SHALL be omitted rather than displacing the node's status or identity
