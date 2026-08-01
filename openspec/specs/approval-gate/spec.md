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
When an Approval-Gate becomes ready, the system SHALL compute and display a diff of the pending changes before the user is asked to approve or reject. The diff SHALL be the difference between the working tree of the gate's working directory and the run baseline recorded in run-state.

#### Scenario: Gate reached after an Implement node
- **WHEN** an Approval-Gate's upstream dependency completes and the gate becomes ready
- **THEN** the system SHALL render the diff between the working tree and the run baseline in the gate's expandable view, together with a summary of each upstream node's output

#### Scenario: Run started with a dirty working tree
- **WHEN** a gate becomes ready in a run started with the dirty-tree override
- **THEN** the rendered diff SHALL contain only changes made since the baseline snapshot, and SHALL NOT present the user's pre-existing uncommitted changes as agent output

#### Scenario: Gate downstream of a Worktree-Agent convergence
- **WHEN** an Approval-Gate's upstream dependency is a Worktree-Agent node whose convergence has selected one or more branches
- **THEN** the diff SHALL be computed against each selected branch's working directory, and the gate SHALL identify which branch each diff belongs to

### Requirement: Explicit reject halts the branch
Rejecting an Approval-Gate SHALL halt that branch of the run; the system SHALL NOT start any node downstream of the gate.

#### Scenario: User rejects a gate
- **WHEN** the user rejects an Approval-Gate
- **THEN** the system SHALL set the gate's status to `error`, set every node downstream of it to `skipped`, and stop that branch of the graph without starting any of those nodes

#### Scenario: Independent branches are unaffected
- **WHEN** a gate is rejected and the graph contains a branch that does not depend on that gate
- **THEN** nodes on the independent branch SHALL continue to run normally

### Requirement: Approve and reject are keyboard-operable
The system SHALL allow the user to approve or reject a focused Approval-Gate using the keyboard alone, with mouse interaction as an optional enhancement.

#### Scenario: Approving without a mouse
- **WHEN** the user focuses a `waiting` Approval-Gate via keyboard navigation and issues the approve action
- **THEN** the gate SHALL transition to `done`, its downstream nodes SHALL become eligible to start, and no mouse input SHALL be required
