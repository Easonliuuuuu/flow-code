# terminal-canvas-ui Specification

## Purpose

Defines the terminal canvas that renders the workflow graph live during a run: node status rendering, keyboard-first navigation with mouse as an optional enhancement, per-node detail views with streamed output and activity logs, and automatic layout with viewport panning.

## Requirements

### Requirement: Live graph rendering
The system SHALL render the loaded workflow graph as boxes connected by edges in the terminal, updating each node's visual status (`idle`, `running`, `waiting`, `done`, `error`, `skipped`) as execution status events arrive.

#### Scenario: Node status changes during a run
- **WHEN** a node transitions from `running` to `done` during execution
- **THEN** the terminal UI SHALL update that node's rendered status within one render cycle without requiring a manual refresh

#### Scenario: Skipped nodes are visually distinct
- **WHEN** nodes are set to `skipped` because an upstream node errored or an upstream gate was rejected
- **THEN** the UI SHALL render them distinctly from `idle` nodes, so the user can tell "will not run" from "not yet started"

### Requirement: Keyboard-first navigation
The system SHALL support navigating between nodes and performing all node interactions (expand, approve, reject) via keyboard alone, independent of mouse support.

#### Scenario: Navigating and expanding a node via keyboard
- **WHEN** the user presses Tab to move focus between nodes and Enter on a focused node
- **THEN** the system SHALL expand that node's detail view without requiring any mouse input

### Requirement: Mouse interaction as enhancement
The system SHALL support mouse click to focus or expand a node and mouse drag to reposition a node, when the terminal emulator reports mouse events, without being required for any workflow action. Positions changed by dragging apply to the current session only and SHALL NOT be written back to the workflow file.

#### Scenario: Terminal without mouse reporting support
- **WHEN** the terminal emulator does not send mouse events
- **THEN** the system SHALL remain fully operable via keyboard alone, with no feature gated behind mouse input

#### Scenario: Dragged position is not persisted
- **WHEN** the user drags a node to a new position and the run ends
- **THEN** `.flow-code/workflow.yaml` SHALL be unmodified, and a subsequent run SHALL lay the graph out from scratch

### Requirement: Node detail view
The system SHALL provide an expandable detail view per node showing its current status, config summary, live streamed output, and its tool-call activity log.

#### Scenario: Expanding a running node
- **WHEN** the user expands a node that is currently `running`
- **THEN** the system SHALL display that node's live streamed output in the detail view, updating as new output arrives

#### Scenario: Viewing what the agent actually ran
- **WHEN** the user expands any node that has executed tool calls
- **THEN** the detail view SHALL show that node's activity log — one row per tool call with its timestamp, tool name, command or input summary, permission decision, and exit status — appended live as new calls occur

#### Scenario: Denied action is visible in the node
- **WHEN** the capability harness denies a tool call for a node
- **THEN** that denial SHALL appear in the node's activity log marked as denied, naming the missing capability, and the node SHALL carry a visible indicator that at least one action was blocked

### Requirement: Graph layout and viewport
The system SHALL arrange nodes automatically in a left-to-right layout derived from the graph's dependency order, and SHALL remain usable when the graph does not fit the terminal viewport.

#### Scenario: Graph is laid out without explicit positions
- **WHEN** a workflow file declares nodes and edges with no position information
- **THEN** the system SHALL compute a left-to-right arrangement in which every node is drawn after all of its dependencies

#### Scenario: Graph exceeds the terminal size
- **WHEN** the rendered graph is larger than the terminal viewport
- **THEN** the system SHALL allow the user to pan the viewport via keyboard, and focusing a node via keyboard navigation SHALL bring that node into view
