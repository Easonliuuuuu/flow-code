## RENAMED Requirements

- FROM: `### Requirement: Edges carry no behavior`
- TO: `### Requirement: Edges route, node types judge`

## MODIFIED Requirements

### Requirement: Edges route, node types judge
An edge in the workflow file SHALL be able to decide whether a path carries, and SHALL NOT be able to decide whether the node it leaves succeeded or failed. An edge MAY declare a routing condition guarding whether its target runs, and a loop-back edge MAY declare which outcome takes it; neither SHALL determine that outcome. Blocking, gating, and approval SHALL be expressed by placing nodes on the graph rather than by annotating edges.

The recognized edge properties SHALL be exactly those the edge schema accepts, and an edge declaring anything else SHALL be rejected before execution.

#### Scenario: Gating an arbitrary transition
- **WHEN** the user wants a transition between two arbitrary nodes to require approval
- **THEN** the user SHALL express this by inserting an Approval-Gate node between them, and the system SHALL enforce the gate identically regardless of which node types sit on either side

#### Scenario: Unrecognized edge property
- **WHEN** an edge declares any property other than `from`, `to`, `when`, and the loop-back declaration with its attempt bound and its trigger
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the unrecognized property

#### Scenario: A routing condition is a recognized property
- **WHEN** an edge declares a `when` condition
- **THEN** the system SHALL accept it and evaluate it to decide whether the edge carries, rather than rejecting the edge as carrying an unrecognized property

#### Scenario: An edge cannot decide success or failure
- **WHEN** an edge attempts to declare a condition, predicate, or verdict governing whether its source node succeeded
- **THEN** the system SHALL fail before starting execution, because that determination belongs to the node type

#### Scenario: Routing does not become judging
- **WHEN** an edge's routing condition does not hold, or a loop-back's declared trigger does not match how its source ended
- **THEN** the system SHALL leave the source node's recorded status exactly as its node type determined it, and SHALL express the routing decision only in whether the path is taken
