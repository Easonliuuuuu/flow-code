# approval-gate Specification

## Purpose

Defines the Approval-Gate node type: a first-class graph node that blocks downstream execution until the user explicitly approves, renders the pending diff against the run baseline before approval, halts its branch on reject, and is fully keyboard-operable.
## Requirements
### Requirement: Approval-Gate is a node type
The Approval-Gate SHALL be a built-in node type placed on the graph like any other node — with its own node id, status, detail view, and focus target — and SHALL NOT be expressed as a property of an edge.

#### Scenario: Gate appears in the graph
- **WHEN** a workflow file declares an Approval-Gate node
- **THEN** the system SHALL render it as a node box in the graph, allow it to be focused and expanded like any other node, and track its status in the central run-state store

#### Scenario: Gating an arbitrary transition
- **WHEN** the workflow file places an Approval-Gate node between two arbitrary nodes
- **THEN** the system SHALL enforce the same approve/reject behavior regardless of the node types on either side, with no special-casing of the Review → Git-ops pairing

### Requirement: Gate blocks downstream execution until approval
An Approval-Gate node SHALL prevent every node that depends on it from starting until the user explicitly approves, regardless of the completion status of its own upstream dependencies.

#### Scenario: Upstream node completes, gate not yet approved
- **WHEN** every upstream dependency of an Approval-Gate reaches `done` and the user has not yet approved
- **THEN** the gate SHALL hold status `waiting` and no downstream node SHALL start

### Requirement: Diff and summary rendering at the gate
When an Approval-Gate becomes ready, the system SHALL compute and display a diff of the pending changes before the user is asked to approve or reject. The diff SHALL be the difference between the working tree of the gate's working directory and the run baseline recorded in run-state. Alongside it, the system SHALL display the summary of each upstream node's output — the summaries themselves, not merely the names of the nodes they came from, since the decision is about what those nodes produced.

#### Scenario: Gate reached after an Implement node
- **WHEN** an Approval-Gate's upstream dependency completes and the gate becomes ready
- **THEN** the system SHALL render the diff between the working tree and the run baseline in the gate's expandable view, together with a summary of each upstream node's output

#### Scenario: The upstream summaries are legible to the approver
- **WHEN** a gate is waiting and its upstream nodes recorded output
- **THEN** the panel SHALL render the content of those summaries, bounded so that they cannot displace the diff or document being decided on

#### Scenario: Run started with a dirty working tree
- **WHEN** a gate becomes ready in a run started with the dirty-tree override
- **THEN** the rendered diff SHALL contain only changes made since the baseline snapshot, and SHALL NOT present the user's pre-existing uncommitted changes as agent output

#### Scenario: Gate downstream of a Worktree-Agent convergence
- **WHEN** an Approval-Gate's upstream dependency is a Worktree-Agent node whose convergence has selected one or more branches
- **THEN** the diff SHALL be computed against each selected branch's working directory, and the gate SHALL identify which branch each diff belongs to

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

### Requirement: Approve and reject are keyboard-operable
The system SHALL allow the user to approve or reject a focused Approval-Gate using the keyboard alone, with mouse interaction as an optional enhancement.

#### Scenario: Approving without a mouse
- **WHEN** the user focuses a `waiting` Approval-Gate via keyboard navigation and issues the approve action
- **THEN** the gate SHALL transition to `done`, its downstream nodes SHALL become eligible to start, and no mouse input SHALL be required

### Requirement: A gate can put a document in front of the user
An Approval-Gate SHALL be able to present a document — a body of text drawn from an upstream node's result — as the subject of the decision, in addition to or instead of a diff. A gate whose upstream produced no change to the working tree SHALL still be able to ask for a decision on something.

The system SHALL derive the documents from the gate's direct dependencies rather than from gate configuration, so that a gate placed after a document-producing node needs no configuration to show what it is gating.

#### Scenario: Gate placed after a Spec node
- **WHEN** an Approval-Gate's direct dependency is a Spec node that has completed
- **THEN** the gate SHALL present that run's spec as a document, labelled with the node it came from, and SHALL wait for an approve or reject decision on it

#### Scenario: The document is the artefact the run will use
- **WHEN** the gate presents a Spec node's document
- **THEN** the body SHALL be read from the file at the path the Spec node recorded, so that what the user approves is the artefact downstream nodes will actually read, not a second rendering of it

#### Scenario: The document reflects a re-run upstream
- **WHEN** a rejection loops back and the upstream Spec node runs again, rewriting its file
- **THEN** the gate SHALL present the rewritten document on the new pass, not the document from the previous attempt

#### Scenario: Upstream produced no document
- **WHEN** none of a gate's direct dependencies produced a document
- **THEN** the gate SHALL present the diff alone, exactly as before, and SHALL NOT report the absence of documents as an error

### Requirement: A document is rendered as prose, not as a diff
The system SHALL render a gate's documents on a separate presentation path from its diffs. Diff presentation attributes meaning to a line's first character — a leading `-` is a deletion, a leading `+` an addition — and a document carries no such convention, so rendering one through the other misstates its content.

#### Scenario: A document of bulleted lines
- **WHEN** the gate presents a document whose lines begin with `-`, such as a spec's acceptance criteria
- **THEN** those lines SHALL be rendered as ordinary document text, and SHALL NOT be coloured or marked as deletions

#### Scenario: A gate with both a document and a diff
- **WHEN** a gate presents both
- **THEN** each SHALL be rendered on its own path, and the diff's additions and deletions SHALL remain distinguishable

### Requirement: An empty diff is not shown beside a document
When an Approval-Gate has at least one document and its diff is empty, the system SHALL present the documents as the body of the decision and SHALL NOT render the empty diff. A gate that asks for a decision while displaying "no changes" states something true about the wrong subject and reads as a gate with nothing in it.

#### Scenario: Spec gate before any code is written
- **WHEN** a gate presents a spec document and no upstream node has modified the working tree
- **THEN** the panel SHALL show the spec as the body, and SHALL NOT show an empty or "no changes" diff region

#### Scenario: Gate with no document and no diff
- **WHEN** a gate has neither a document nor any pending change
- **THEN** the panel SHALL continue to say that there is nothing to show, rather than presenting a blank body

