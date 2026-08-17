## MODIFIED Requirements

### Requirement: Live graph rendering
The system SHALL render the loaded workflow graph as boxes connected by edges in the terminal, updating each node's visual status (`idle`, `running`, `waiting`, `done`, `error`, `skipped`) as execution status events arrive. Loop-back edges SHALL be rendered as visually distinct return paths, and a node that has run more than once SHALL show how many attempts it has taken.

#### Scenario: Node status changes during a run
- **WHEN** a node transitions from `running` to `done` during execution
- **THEN** the terminal UI SHALL update that node's rendered status within one render cycle without requiring a manual refresh

#### Scenario: Skipped nodes are visually distinct
- **WHEN** nodes are set to `skipped` because an upstream node errored, or because an edge condition that guards them did not hold
- **THEN** the UI SHALL render them distinctly from `idle` nodes, so the user can tell "will not run" from "not yet started"

#### Scenario: A rejected gate does not read as a success
- **WHEN** an Approval-Gate reaches `done` with a recorded decision of `rejected`
- **THEN** the UI SHALL render it distinctly from an approved gate, so its terminal status alone does not present the rejection as a successful outcome

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
