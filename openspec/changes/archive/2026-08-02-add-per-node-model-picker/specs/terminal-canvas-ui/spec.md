## MODIFIED Requirements

### Requirement: Keyboard-first navigation
The system SHALL support navigating between nodes and performing all node interactions (expand, approve, reject, choose the node's model) via keyboard alone, independent of mouse support.

#### Scenario: Navigating and expanding a node via keyboard
- **WHEN** the user presses Tab to move focus between nodes and Enter on a focused node
- **THEN** the system SHALL expand that node's detail view without requiring any mouse input

#### Scenario: Choosing a node's model via keyboard
- **WHEN** the user presses the model-picker key on a focused node and confirms a selection with the keyboard
- **THEN** the system SHALL apply that model to the node without requiring any mouse input

### Requirement: Mouse interaction as enhancement
The system SHALL support mouse click to focus or expand a node and mouse drag to reposition a node, when the terminal emulator reports mouse events, without being required for any workflow action. Positions changed by dragging apply to the current session only and SHALL NOT be written back to the workflow file. Changes the user makes to a node's configuration, such as its model, are not viewport state and ARE written back to the workflow file.

#### Scenario: Terminal without mouse reporting support
- **WHEN** the terminal emulator does not send mouse events
- **THEN** the system SHALL remain fully operable via keyboard alone, with no feature gated behind mouse input

#### Scenario: Dragged position is not persisted
- **WHEN** the user drags a node to a new position and the run ends
- **THEN** `.flow-code/workflow.yaml` SHALL be unmodified, and a subsequent run SHALL lay the graph out from scratch

#### Scenario: Configuration change is persisted
- **WHEN** the user changes a node's model during a run and the run ends
- **THEN** `.flow-code/workflow.yaml` SHALL carry that node's new `config.model`, and a subsequent run SHALL start from it

### Requirement: Node detail view
The system SHALL provide an expandable detail view per node showing its current status, config summary, the model it resolves to, live streamed output, and its tool-call activity log.

#### Scenario: Expanding a running node
- **WHEN** the user expands a node that is currently `running`
- **THEN** the system SHALL display that node's live streamed output in the detail view, updating as new output arrives

#### Scenario: Viewing what the agent actually ran
- **WHEN** the user expands any node that has executed tool calls
- **THEN** the detail view SHALL show that node's activity log — one row per tool call with its timestamp, tool name, command or input summary, permission decision, and exit status — appended live as new calls occur

#### Scenario: Denied action is visible in the node
- **WHEN** the capability harness denies a tool call for a node
- **THEN** that denial SHALL appear in the node's activity log marked as denied, naming the missing capability, and the node SHALL carry a visible indicator that at least one action was blocked

#### Scenario: Seeing which model a node runs on
- **WHEN** the user expands an agent-driven node
- **THEN** the detail view SHALL name the model that node resolves to and where that model came from
