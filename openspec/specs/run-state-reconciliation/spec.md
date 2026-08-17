# run-state-reconciliation Specification

## Purpose

Defines the read-only check that asks the repository whether a run's claims are true. Guest reports are self-declared, so a graph can confidently show work that never happened; reconciliation compares claimed node state against the tree from the run's recorded baseline, never rewrites the run it checks, and surfaces disagreement where the run is watched.

## Requirements
### Requirement: Claimed node state is checked against the repository
The system SHALL be able to compare what a run claims happened against what the repository shows, using the run's recorded baseline as the reference point, and SHALL report nodes whose claim is not supported by the tree. This exists because a guest agent's reports are self-declared: a graph that confidently shows work that was never done is worse than a graph that shows nothing.

#### Scenario: A node claims completion with no corresponding change
- **WHEN** reconciliation runs against a run where a node whose type is expected to modify the repository is `done`, but the tree is unchanged from the baseline
- **THEN** the system SHALL report that node as unsupported by the tree, naming the node and what it expected to find

#### Scenario: A claim is supported by the tree
- **WHEN** reconciliation runs against a run whose `done` nodes correspond to changes present in the tree
- **THEN** the system SHALL report no disagreement for those nodes

#### Scenario: Nodes that modify nothing are not flagged
- **WHEN** reconciliation runs against a run containing a completed node whose type is not expected to modify the repository
- **THEN** the system SHALL NOT report that node as unsupported merely because the tree is unchanged

#### Scenario: A run with no recorded baseline
- **WHEN** reconciliation runs against a run that has no baseline recorded
- **THEN** the system SHALL report that the run cannot be reconciled and SHALL name the missing baseline as the reason, rather than reporting a false result

### Requirement: Reconciliation never rewrites the run it checks
The system SHALL treat reconciliation as read-only with respect to run-state. Findings SHALL be reported to the caller and SHALL NOT silently correct, delete, or overwrite what the run claims.

#### Scenario: Disagreement is found
- **WHEN** reconciliation finds a node whose claim the tree does not support
- **THEN** the system SHALL report the finding, and the run-state document SHALL be byte-identical to what it was before the check ran

### Requirement: Disagreement is visible where the run is watched
The system SHALL make reconciliation findings available to the viewer, so a run whose claims do not match the repository is identifiable while it is being watched rather than only after the fact.

#### Scenario: A watched run has unsupported claims
- **WHEN** a viewer is attached to a run for which reconciliation has found unsupported claims
- **THEN** the viewer SHALL indicate that the run's claims and the repository disagree, and SHALL identify which nodes are affected
