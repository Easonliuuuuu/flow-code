# terminal-canvas-ui Specification

## Purpose

Defines the terminal canvas that renders the workflow graph live during a run: node status rendering, keyboard-first navigation with mouse as an optional enhancement, per-node detail views with streamed output and activity logs, and automatic layout with viewport panning.

## Requirements

### Requirement: Live graph rendering
The system SHALL render the loaded workflow graph as boxes connected by edges in the terminal, updating each node's visual status (`idle`, `running`, `waiting`, `done`, `error`, `skipped`) as execution status events arrive. Loop-back edges SHALL be rendered as visually distinct return paths, and a node that has run more than once SHALL show how many attempts it has taken.

#### Scenario: Node status changes during a run
- **WHEN** a node transitions from `running` to `done` during execution
- **THEN** the terminal UI SHALL update that node's rendered status within one render cycle without requiring a manual refresh

#### Scenario: Skipped nodes are visually distinct
- **WHEN** nodes are set to `skipped` because an upstream node errored or an upstream gate was rejected
- **THEN** the UI SHALL render them distinctly from `idle` nodes, so the user can tell "will not run" from "not yet started"

#### Scenario: Loop-back edges are distinguishable from forward edges
- **WHEN** the workflow declares a loop-back edge
- **THEN** the UI SHALL render it as a return path that is visually distinguishable from a forward edge, and SHALL route it so it does not overlap the forward edges between the same two nodes

#### Scenario: A node re-run by a loop-back shows its attempt count
- **WHEN** a node has been executed more than once because of a loop-back
- **THEN** its rendered box SHALL indicate the current attempt number, and a node on its first attempt SHALL show no such indicator

#### Scenario: Reset nodes return to their pre-run appearance
- **WHEN** a loop-back resets a segment of previously completed nodes
- **THEN** those nodes SHALL render as `idle` again within one render cycle, so the user sees the loop take effect rather than a frozen stale status

#### Scenario: The active loop is identifiable
- **WHEN** a loop-back fires
- **THEN** the UI SHALL indicate which loop-back edge fired and which node triggered it, so the user can tell why execution moved backwards

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

#### Scenario: Output line wider than the panel
- **WHEN** a node's streamed output contains a line wider than the detail panel's inner width
- **THEN** the system SHALL wrap that line onto further rows so its full text is readable, rather than cutting it off at the panel's right edge

### Requirement: Discuss transcript formatting
The Discuss panel SHALL render the agent's markdown as terminal styling rather than as literal markup, wrapping every row to the panel's inner width so no text is cut off at its right edge. The user's own messages SHALL be shown exactly as typed.

#### Scenario: Agent replies in markdown
- **WHEN** an agent message in the Discuss transcript contains markdown — headings, list items, fenced or inline code, emphasis, block quotes, or links
- **THEN** the panel SHALL render the styling those markers denote and SHALL NOT display the markers themselves

#### Scenario: User types markdown characters
- **WHEN** the user's own message contains characters that are markdown markers
- **THEN** the panel SHALL display that message verbatim, since the user typed those characters deliberately

#### Scenario: Transcript line wider than the panel
- **WHEN** a transcript message is wider than the panel's inner width
- **THEN** the panel SHALL wrap it onto further rows, breaking between words where possible and never inside a styled span's word, and SHALL hard-break only a single token wider than the panel

### Requirement: Graph layout and viewport
The system SHALL arrange nodes automatically in a left-to-right layout derived from the graph's forward-edge dependency order, and SHALL remain usable when the graph does not fit the terminal viewport. Loop-back edges SHALL NOT participate in layer assignment.

#### Scenario: Graph is laid out without explicit positions
- **WHEN** a workflow file declares nodes and edges with no position information
- **THEN** the system SHALL compute a left-to-right arrangement in which every node is drawn after all of its forward-edge dependencies

#### Scenario: Graph exceeds the terminal size
- **WHEN** the rendered graph is larger than the terminal viewport
- **THEN** the system SHALL allow the user to pan the viewport via keyboard, and focusing a node via keyboard navigation SHALL bring that node into view

#### Scenario: Loop-back edges do not distort the layout
- **WHEN** a workflow declares a loop-back edge from a node to one of its ancestors
- **THEN** layer assignment SHALL be computed over the forward edges alone, so the presence of the loop-back does not change where any node is placed

### Requirement: Attempt history in the node detail view
A node's detail view SHALL surface its attempt history when it has run more than once, so the user can compare what changed between attempts without leaving the UI.

#### Scenario: Inspecting a re-run node
- **WHEN** the user expands the detail view of a node that has been executed more than once
- **THEN** the view SHALL show the number of attempts and the terminal status of each prior attempt

#### Scenario: Detail view of a first-attempt node is unchanged
- **WHEN** the user expands the detail view of a node that has run at most once
- **THEN** the view SHALL show no attempt history section
