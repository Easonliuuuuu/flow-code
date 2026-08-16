## ADDED Requirements

### Requirement: The canvas absorbs a graph that grows mid-run
When a Plan node's accepted graph is spliced in, the canvas SHALL render the expanded graph without requiring a restart or a manual refresh. Layer assignment SHALL be recomputed over the expanded forward-edge subgraph by the same layout the canvas applies to a graph declared in a workflow file, so an expanded graph and a hand-written one of the same shape SHALL be laid out identically.

#### Scenario: Nodes appear after the Plan node completes
- **WHEN** a three-node spine is expanded into a larger graph
- **THEN** the canvas SHALL render the expanded graph within one render cycle, with every node's status shown, and SHALL NOT require the user to restart or refresh

#### Scenario: Expansion does not disturb focus
- **WHEN** the graph is expanded while a node is focused
- **THEN** the focused node SHALL remain focused if it is still present in the expanded graph, and focus SHALL move to a defined node rather than being lost if it is not

#### Scenario: An expanded graph larger than the viewport
- **WHEN** expansion produces a graph larger than the terminal viewport
- **THEN** the canvas SHALL remain pannable by keyboard and focusing a node SHALL bring it into view, exactly as for a workflow file declaring the same graph

#### Scenario: Layout matches an equivalent static graph
- **WHEN** an expanded graph and a workflow file declare the same nodes and edges
- **THEN** the canvas SHALL lay them out identically, because layout is derived from the graph rather than from how it arrived
