## MODIFIED Requirements

### Requirement: Explicit reject halts the branch
Rejecting an Approval-Gate SHALL halt that branch of the run; the system SHALL NOT start any node downstream of the gate that is conditioned on approval. A rejected gate SHALL reach the terminal status `done` with a recorded decision of `rejected`, because a gate that received its answer completed — the halt SHALL be carried by the recorded decision and the edges conditioned on it, not by an execution failure.

#### Scenario: User rejects a gate
- **WHEN** the user rejects an Approval-Gate
- **THEN** the system SHALL set the gate's status to `done` with a recorded decision of `rejected`, set every node reachable only through an edge conditioned on approval to `skipped`, and stop that branch of the graph without starting any of those nodes

#### Scenario: Independent branches are unaffected
- **WHEN** a gate is rejected and the graph contains a branch that does not depend on that gate
- **THEN** nodes on the independent branch SHALL continue to run normally

#### Scenario: A rejected gate is not reported as a successful run
- **WHEN** a run ends with a rejected Approval-Gate and no other failure
- **THEN** the run SHALL report a non-zero exit status, SHALL raise the same attention signal it raises for a failed node, and SHALL NOT present the gate as a successful outcome in the rendered graph

#### Scenario: Rejected work never reaches git
- **WHEN** a workflow declares an edge from an Approval-Gate to a repository-mutating node and does not state a condition on that edge
- **THEN** the system SHALL NOT run that node after a rejection, and SHALL NOT commit or push the rejected changes

## ADDED Requirements

### Requirement: A recorded gate decision carries the diff it was made on
The output recorded for a decided Approval-Gate SHALL include the diff the user was shown, so that the decision remains reviewable after the fact and any node downstream of the gate receives the changes that were accepted or rejected rather than the bare decision.

#### Scenario: Reopening a decided gate
- **WHEN** the user opens the detail view of an Approval-Gate that has already been decided
- **THEN** the system SHALL render the same diff that was shown at decision time

#### Scenario: A downstream node receives the decided diff
- **WHEN** a node runs downstream of a decided Approval-Gate
- **THEN** the gate's recorded output in that node's upstream context SHALL include the diff, bounded by the same context budget that applies to every other upstream output

### Requirement: A rejection can route to another node
A workflow SHALL be able to declare a node that runs only when an Approval-Gate is rejected, so that a rejection can begin another iteration rather than only ending the run. The system SHALL NOT require a new node type for this: any node type may be placed on the rejection branch.

#### Scenario: Rejection routes to a revision step
- **WHEN** a workflow declares an edge from an Approval-Gate to a node conditioned on the gate's decision being `rejected`, and the user rejects the gate
- **THEN** the system SHALL start that node, and SHALL skip the nodes on the approval branch

#### Scenario: The revision step sends the work back
- **WHEN** that node completes and declares a loop-back to an upstream node that is taken on success
- **THEN** the system SHALL re-run that segment with the node's recorded conclusion as the reason for the retry, and the approval branch SHALL be decided again on the new pass

#### Scenario: Approval does not take the rejection branch
- **WHEN** the same workflow's gate is approved
- **THEN** the system SHALL skip the node on the rejection branch and start the nodes on the approval branch
