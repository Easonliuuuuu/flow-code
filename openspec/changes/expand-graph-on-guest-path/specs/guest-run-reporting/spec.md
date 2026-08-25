## ADDED Requirements

### Requirement: A reported Plan node expands the run's graph
The system SHALL splice a reported Plan node's proposal into the run's recorded graph before the report is acknowledged, so that the nodes it planned exist and can be reported against. A guest-driven expansion SHALL produce the same recorded graph an engine-driven run produces from the same proposal, because both SHALL go through one shared entry point rather than two implementations of the splice.

Expansion SHALL NOT change the run's enforcement tier: a run that expands is reported at whatever tier it already held.

#### Scenario: A Plan node is reported complete with a proposal
- **WHEN** a guest reports a Plan node complete, supplying nodes and edges for the Plan output shape
- **THEN** the system SHALL rebuild the run's recorded graph with the proposal spliced in place of the Plan node's successors, SHALL record the Plan node as `done` with its proposal as output, and SHALL persist the rebuilt graph to run-state

#### Scenario: The planned nodes can be reported against
- **WHEN** a guest reports a node that exists only because a Plan node's proposal introduced it
- **THEN** the system SHALL accept the transition on the same terms as any other node, rather than rejecting it as a node id the workflow does not define

#### Scenario: A viewer attached to the run sees the expansion
- **WHEN** a run being watched expands through a reported Plan node
- **THEN** the viewer SHALL redraw from the rebuilt graph without reattaching, the same way it does for an engine-driven expansion

#### Scenario: An expanded run keeps its tier
- **WHEN** a run recorded at the `hooks` tier expands through a reported Plan node
- **THEN** the run SHALL still be reported at `hooks`, and its recorded absent guarantees SHALL be unchanged

### Requirement: A proposal that does not build is refused at report time
The system SHALL validate a reported proposal by building the spliced graph before accepting the report, and SHALL reject the report when the result is not a valid workflow — including a proposal that would leave a `git-write` node reachable without passing an Approval-Gate. A refused proposal SHALL leave run-state unchanged, so the Plan node stays `running` and the guest can propose again.

#### Scenario: The proposal routes around the approval gate
- **WHEN** a guest reports a Plan node complete with a proposal whose graph reaches a git-writing node without passing an Approval-Gate
- **THEN** the system SHALL reject the report, naming the node and the path that misses a gate, and run-state SHALL be left unchanged

#### Scenario: The proposal is structurally invalid
- **WHEN** a guest reports a proposal that names an unknown node type, duplicates an existing node id, or declares an edge to a node that does not exist
- **THEN** the system SHALL reject the report with the same message the engine reports for that proposal, and run-state SHALL be left unchanged

#### Scenario: A second Plan node is proposed
- **WHEN** a proposal introduces a Plan node
- **THEN** the system SHALL reject the report, since a graph may declare at most one Plan node and it must be a root

### Requirement: A guest is told what the run holds after an expansion
The system SHALL return the run's node ids after a successful expansion, on both the CLI and MCP reporting surfaces, because the nodes a guest may report next are ones that did not exist when it was briefed and are not in any instructions it has read.

#### Scenario: The CLI reports a Plan node complete
- **WHEN** a guest completes a Plan node via `flow-code node done`
- **THEN** the command SHALL print the node ids the run now holds, in graph order

#### Scenario: The MCP tool reports a Plan node complete
- **WHEN** a guest completes a Plan node via the MCP reporting tool
- **THEN** the tool result SHALL carry the node ids the run now holds, in graph order
