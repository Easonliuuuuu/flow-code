## ADDED Requirements

### Requirement: The recorded graph is replaced when a Plan node expands it
When a Plan node completes and its accepted graph is spliced in, the run document SHALL record the expanded graph in place of the one it recorded at run start, before any expanded node leaves `idle`. Execution state already recorded SHALL remain attributed to the nodes that produced it. The replacement SHALL go through the same recording path a run start uses, so a recorded graph means the same thing whether it was written once or replaced.

#### Scenario: Expanded graph is recorded before its nodes run
- **WHEN** a Plan node's accepted graph is spliced into the run
- **THEN** the run document SHALL describe the expanded graph before any node of it leaves `idle`, so a reader attaching at that moment sees the shape that is actually running

#### Scenario: Completed state survives the replacement
- **WHEN** the recorded graph is replaced by an expanded one
- **THEN** the Plan node SHALL remain `done` with its output intact, and SHALL NOT be reset to `idle` or re-executed

#### Scenario: A reader attached across an expansion
- **WHEN** a reader is attached to a run whose graph is replaced
- **THEN** it SHALL describe the expanded graph from the run document without reloading the workflow file, and SHALL NOT report the run as having two graphs

#### Scenario: Resuming a run interrupted after expansion
- **WHEN** a run is interrupted after its graph was expanded and is then resumed
- **THEN** the resumed run SHALL execute the expanded graph recorded in the document, rebuilt through the same checks as any recorded graph

#### Scenario: Resuming a run interrupted before expansion
- **WHEN** a run is interrupted while its Plan node is still negotiating and is then resumed
- **THEN** the resumed run SHALL execute the unexpanded graph recorded at run start, and the Plan node SHALL be re-entered rather than treated as complete
