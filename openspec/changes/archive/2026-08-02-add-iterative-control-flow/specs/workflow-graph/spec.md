## MODIFIED Requirements

### Requirement: Graph structural validation
The system SHALL validate, before execution, that the workflow graph has no dangling edges and that its forward edges form a directed acyclic graph. Loop-back edges are exempt from the acyclicity check and SHALL instead be validated as pointing to a node that is an ancestor of the edge's source over the forward-edge subgraph.

#### Scenario: Cycle in graph
- **WHEN** the workflow file's forward edges form a cycle
- **THEN** the system SHALL fail before starting execution with an error identifying the nodes involved in the cycle

#### Scenario: Edge references unknown node
- **WHEN** an edge's `from` or `to` references a node id not defined in the `nodes` list
- **THEN** the system SHALL fail before starting execution with an error naming the invalid edge

#### Scenario: Loop-back edge does not create a validation cycle
- **WHEN** the workflow file declares a loop-back edge from a node to one of its forward-edge ancestors
- **THEN** the system SHALL accept the graph and compute a topological order over the forward edges alone

#### Scenario: Loop-back edge does not target an ancestor
- **WHEN** a loop-back edge's target is not an ancestor of its source over the forward-edge subgraph
- **THEN** the system SHALL fail before starting execution with an error naming the edge and stating that a loop-back must point back to an upstream node

### Requirement: Edges carry no behavior
Edges in the workflow file SHALL declare only graph structure: `from`, `to`, and — for loop-back edges — the declaration that the edge is a loop-back together with its attempt bound. All blocking, gating, and approval behavior SHALL be expressed by placing nodes on the graph, never by annotating edges. Whether a node succeeds or fails SHALL be determined by its node type, never by an edge.

#### Scenario: Gating an arbitrary transition
- **WHEN** the user wants a transition between two arbitrary nodes to require approval
- **THEN** the user SHALL express this by inserting an Approval-Gate node between them, and the system SHALL enforce the gate identically regardless of which node types sit on either side

#### Scenario: Unrecognized edge property
- **WHEN** an edge declares any property other than `from`, `to`, and the loop-back declaration with its attempt bound
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the unrecognized property

#### Scenario: An edge cannot decide success or failure
- **WHEN** an edge attempts to declare a condition, predicate, or verdict governing whether its source node succeeded
- **THEN** the system SHALL fail before starting execution, because that determination belongs to the node type

### Requirement: Built-in node type registry
The system SHALL expose a registry of built-in node types (Discuss, Implement, Test, Validate, Review, Git-ops, Worktree-Agent, Approval-Gate). Each type SHALL be defined by a capability set, a default role prompt, and an output schema, in addition to its config schema. A type MAY additionally declare that it is context-transparent and MAY declare a failure predicate over its own output.

#### Scenario: Listing available node types
- **WHEN** the user runs `flow-code node-types`
- **THEN** the system prints every built-in node type's id, its capability set, a short description of its config schema, and the shape of its output

#### Scenario: Every type declares a capability set
- **WHEN** a node type is registered
- **THEN** it SHALL declare the capabilities its execution is permitted to use, drawn from `read`, `edit`, `exec`, `git-read`, and `git-write`

#### Scenario: No node type has network access
- **WHEN** any built-in node type is registered
- **THEN** its capability set SHALL NOT grant network access, and network-capable tools SHALL be unavailable to every agent session in this version

#### Scenario: Verification node types cannot edit
- **WHEN** the Test, Validate, or Review node types are registered
- **THEN** their capability sets SHALL NOT include `edit`, so a verification step cannot satisfy its own criteria by modifying the code or the tests it is checking

#### Scenario: Only Git-ops may write to git
- **WHEN** any node type other than Git-ops is registered
- **THEN** its capability set SHALL NOT include `git-write`

#### Scenario: Verification types declare a failure predicate
- **WHEN** the Validate and Review node types are registered
- **THEN** each SHALL declare a failure predicate that holds when its recorded output carries a `fail` verdict

#### Scenario: Approval-Gate is context-transparent
- **WHEN** the Approval-Gate node type is registered
- **THEN** it SHALL be declared context-transparent, so placing a gate on the graph does not sever the context chain across it

## ADDED Requirements

### Requirement: Loop-back edge declaration
The workflow file SHALL allow an edge to be declared as a loop-back, naming the upstream node to return to and the maximum number of attempts permitted, validated before execution like any other part of the file.

#### Scenario: Declaring a loop-back
- **WHEN** the workflow file declares an edge marked as a loop-back with a target node and a maximum attempt count
- **THEN** the system SHALL accept it and SHALL treat that edge as a return path rather than a dependency, so the target does not wait on the source before first running

#### Scenario: Loop-back without an attempt bound
- **WHEN** a loop-back edge is declared without a maximum attempt count
- **THEN** the system SHALL apply a documented default bound rather than allowing an unbounded loop

#### Scenario: Invalid attempt bound
- **WHEN** a loop-back edge declares a maximum attempt count that is not a positive integer
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the invalid value

#### Scenario: Loop-backs do not affect dependency readiness
- **WHEN** the engine determines whether a node's dependencies are satisfied
- **THEN** loop-back edges SHALL be excluded from that determination, so a loop-back into a node does not prevent that node from running on the first pass
