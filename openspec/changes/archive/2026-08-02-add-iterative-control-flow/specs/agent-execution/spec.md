## MODIFIED Requirements

### Requirement: Node output contract
Every node type SHALL produce a structured output value conforming to its declared output schema, recorded in run-state and available to downstream nodes and to any Approval-Gate that depends on it. A node type MAY declare a failure predicate over its own recorded output; when the predicate holds, the node's terminal status SHALL be `error` rather than `done`.

#### Scenario: Implement node produces a diff
- **WHEN** an Implement node reaches `done`
- **THEN** its recorded output SHALL include the set of changed files and the diff produced during its execution

#### Scenario: Review node produces a verdict
- **WHEN** a Review node reaches `done`
- **THEN** its recorded output SHALL include a pass/fail verdict and a list of findings, each with a location and a description

#### Scenario: Test node produces per-command results
- **WHEN** a Test node finishes
- **THEN** its recorded output SHALL include, for each configured command, the command string, its exit status, and its captured output

#### Scenario: Discuss node produces a conclusion
- **WHEN** a Discuss node reaches `done`
- **THEN** its recorded output SHALL include the conclusion reached and any constraints or decisions agreed during the discussion, in a form a downstream node can consume without replaying the transcript

#### Scenario: A failing verdict fails the node
- **WHEN** a Validate or Review node completes its session and its recorded output carries a `fail` verdict
- **THEN** the node's terminal status SHALL be `error`, its recorded output SHALL still be stored in full, and its status detail SHALL identify the verdict as the reason

#### Scenario: A passing verdict completes the node
- **WHEN** a node type declaring a failure predicate completes and its recorded output does not satisfy that predicate
- **THEN** the node's terminal status SHALL be `done`

#### Scenario: Failure predicate is declared by the type, not the edge
- **WHEN** a node type declares a failure predicate
- **THEN** that predicate SHALL be a property of the node type in the registry, and no edge in the workflow file SHALL be able to declare, override, or suppress it

### Requirement: Upstream output propagation
When a node starts, the system SHALL provide it with the recorded outputs of its direct upstream dependencies as part of its initial context. A node type MAY declare itself context-transparent; a context-transparent node SHALL forward the outputs of its own direct dependencies alongside its recorded output, so that inserting one into the graph does not sever the context chain.

#### Scenario: Implement node consumes the preceding discussion
- **WHEN** an Implement node whose only dependency is a Discuss node starts
- **THEN** that Discuss node's recorded output SHALL be present in the Implement node's initial context

#### Scenario: Node with multiple dependencies
- **WHEN** a node with more than one direct upstream dependency starts
- **THEN** the outputs of all of its direct dependencies SHALL be present in its initial context, each labelled with the node id that produced it

#### Scenario: Indirect ancestors are not propagated
- **WHEN** a node starts and the graph contains nodes that are ancestors but not direct dependencies, and no context-transparent node lies between them
- **THEN** those nodes' outputs SHALL NOT be injected into its context, so context growth is bounded by fan-in rather than by graph depth

#### Scenario: Context survives an Approval-Gate
- **WHEN** a node's only direct dependency is an Approval-Gate
- **THEN** that node's initial context SHALL contain both the gate's decision and the recorded outputs of the gate's own direct dependencies, each labelled with the node id that produced it

#### Scenario: Chained context-transparent nodes
- **WHEN** two context-transparent nodes are adjacent on the graph
- **THEN** forwarding SHALL compose through them, and each forwarded output SHALL appear at most once in the resulting context regardless of how many paths reach it

#### Scenario: Oversized upstream output
- **WHEN** an upstream node's recorded output exceeds the configured size limit for context injection
- **THEN** the system SHALL inject a truncated form marked as truncated, and the full output SHALL remain available in run-state

#### Scenario: Forwarding respects the size limit
- **WHEN** the combined forwarded context through a context-transparent node exceeds the configured size limit
- **THEN** the system SHALL truncate as it does for any oversized upstream output, and the full outputs SHALL remain available in run-state

## ADDED Requirements

### Requirement: Loop-back re-execution
When a node fails and a loop-back edge declares that node as its source, the system SHALL reset the loop-back target and every node on a path from that target to the source, then re-execute that segment rather than terminating the run.

#### Scenario: A failed verification returns to implementation
- **WHEN** a Validate node fails and a loop-back edge is declared from that Validate node to an upstream Implement node
- **THEN** the system SHALL reset the Implement node and every node between it and the Validate node to `idle`, and SHALL re-run that segment

#### Scenario: Nodes outside the loop segment are untouched
- **WHEN** a loop-back resets a segment
- **THEN** nodes that are not on any path from the loop-back target to the failing node SHALL retain their recorded status and output, and nodes downstream of the failing node SHALL remain unstarted rather than `skipped`

#### Scenario: Reset clears node results
- **WHEN** a node is reset by a loop-back
- **THEN** its recorded output, status detail, and streamed live output SHALL be cleared for the new attempt, and its accumulated activity log SHALL be retained

#### Scenario: The retried segment learns why it failed
- **WHEN** a loop-back target is re-executed
- **THEN** its initial context SHALL include the recorded output and status detail of the node that triggered the loop-back, labelled as the reason for the retry

#### Scenario: Loop-back after a rejected gate
- **WHEN** an Approval-Gate is rejected and a loop-back edge declares that gate as its source
- **THEN** the system SHALL reset and re-run the loop-back segment instead of marking the downstream nodes `skipped`

### Requirement: Bounded loop attempts
Every loop-back SHALL be bounded by a maximum attempt count, and the run SHALL terminate rather than loop indefinitely when that bound is reached.

#### Scenario: Attempt limit is reached
- **WHEN** a loop-back has re-run its segment up to its declared maximum attempts and the source node fails again
- **THEN** the system SHALL NOT loop again, SHALL leave the source node in `error`, SHALL mark its downstream nodes `skipped`, and SHALL report that the attempt limit was the reason

#### Scenario: Attempts are recorded per node
- **WHEN** a node has been executed more than once because of a loop-back
- **THEN** run-state SHALL record the number of attempts that node has taken and the terminal status of each prior attempt

#### Scenario: A run with loop-backs still terminates
- **WHEN** a workflow declares one or more loop-back edges
- **THEN** every run of that workflow SHALL reach a terminal state in a bounded number of node executions

#### Scenario: Success resets nothing
- **WHEN** a re-run segment completes and the previously failing node succeeds
- **THEN** execution SHALL continue to that node's downstream nodes normally, and the recorded attempt history SHALL be retained
