## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Attempt history in the node detail view
A node's detail view SHALL surface its attempt history when it has run more than once, so the user can compare what changed between attempts without leaving the UI.

#### Scenario: Inspecting a re-run node
- **WHEN** the user expands the detail view of a node that has been executed more than once
- **THEN** the view SHALL show the number of attempts and the terminal status of each prior attempt

#### Scenario: Detail view of a first-attempt node is unchanged
- **WHEN** the user expands the detail view of a node that has run at most once
- **THEN** the view SHALL show no attempt history section
