## MODIFIED Requirements

### Requirement: Status event streaming
Every node execution SHALL emit a stream of status events drawn from `idle`, `running`, `waiting`, `done`, `error`, and `skipped`, consumed by a central state store independent of whether a UI is attached.

#### Scenario: Node completes successfully
- **WHEN** a node's execution finishes without error
- **THEN** the system SHALL emit a `done` status event and unblock any downstream nodes whose only dependency was this node

#### Scenario: Node execution errors
- **WHEN** a node's execution raises an unrecoverable error
- **THEN** the system SHALL emit an `error` status event, halt that node, and SHALL NOT start downstream nodes that depend on it

#### Scenario: Downstream of a halted node
- **WHEN** a node reaches `error`
- **THEN** every node downstream of it SHALL be set to `skipped` rather than left in `idle`, so the UI can distinguish "will not run" from "not yet started"

#### Scenario: Downstream of a rejected gate
- **WHEN** an Approval-Gate is rejected
- **THEN** every node reachable only through an edge whose condition requires approval SHALL be set to `skipped` by condition evaluation rather than by the failure cascade, and the gate itself SHALL remain `done`

### Requirement: Loop-back re-execution
When a node ends in the way a loop-back edge declaring it as its source is taken on, the system SHALL reset the loop-back target and every node on a path from that target to the source, then re-execute that segment rather than terminating the run. A rejected Approval-Gate SHALL count as a failure for this purpose even though its terminal status is `done`.

Resetting a segment SHALL also return to `idle` every node below the loop-back target that was skipped because a routing condition sent the run elsewhere, since the segment being re-run is what decided that routing. A node skipped because something above it failed SHALL stay skipped.

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
- **THEN** the system SHALL reset and re-run the loop-back segment, and SHALL NOT additionally mark the nodes downstream of the gate `skipped` through the failure cascade

#### Scenario: A branch routed around is reconsidered by the retry
- **WHEN** a loop-back re-runs a segment, and a node below the loop-back target had been skipped because a condition reading that segment did not hold
- **THEN** that node SHALL return to `idle` and be decided again on the new pass, so the re-run has somewhere to deliver its work

## ADDED Requirements

### Requirement: A re-entered interactive node is told why it is running again
When an interactive node is reset and re-executed by a loop-back, the system SHALL deliver that node's upstream context — including the retry reason — to its agent before handing control back to the user. Resuming a prior conversation SHALL NOT suppress that delivery.

#### Scenario: A Discuss node re-entered by a loop-back
- **WHEN** a Discuss node is reset by a loop-back and re-executed while a prior transcript and session for that node still exist
- **THEN** the system SHALL deliver the retry reason and the recorded outputs of that node's upstream dependencies into the resumed session before waiting for the user's next message

#### Scenario: A conversation interrupted rather than looped back
- **WHEN** a Discuss node resumes a conversation that was cut short by an interruption, with no retry reason recorded for it
- **THEN** the system SHALL replay the prior transcript and wait for the user without re-sending an opening prompt

#### Scenario: Repeated re-entry
- **WHEN** an interactive node is re-entered by a loop-back for a second or later time
- **THEN** it SHALL receive the upstream context recorded for that attempt, and SHALL NOT continue on the context of an earlier attempt
