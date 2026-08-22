## ADDED Requirements

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

## MODIFIED Requirements

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
