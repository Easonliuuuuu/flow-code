## ADDED Requirements

### Requirement: The run document describes its own graph
The run document at `.flow-code/runs/<runId>.json` SHALL record the graph the run is executing — every node's id, type and resolved config, and every edge including its loop-back declaration — alongside the per-node execution state it already carries. The recording SHALL hold only what survives serialization: derived structure such as adjacency and execution order SHALL be rebuilt when the graph is read, never stored.

#### Scenario: Graph is recorded when the run starts
- **WHEN** a run begins
- **THEN** the run document SHALL contain the graph before the first node leaves `idle`, so a reader attaching at the run's first instant sees the shape rather than an empty run

#### Scenario: Recorded node state matches the recorded graph
- **WHEN** a run document is created from a graph
- **THEN** the per-node execution state SHALL be seeded from that same graph, so the node map and the recorded shape cannot be built from two lists that disagree

#### Scenario: Editing the workflow file mid-run does not change the recorded graph
- **WHEN** `.flow-code/workflow.yaml` is edited while a run is in progress
- **THEN** the recorded graph SHALL continue to describe what that run is executing, and the edit SHALL apply to subsequent runs rather than retroactively to this one

#### Scenario: A run document written before graphs were recorded
- **WHEN** a run document carries no recorded graph
- **THEN** it SHALL remain readable, and the absence SHALL be distinguishable from an empty graph rather than reported as one

### Requirement: A recorded graph rebuilds through the same checks as a fresh load
A recorded graph SHALL be rebuildable into a runnable workflow, and that rebuild SHALL apply the same node type, node config, skill, and graph structure checks that loading a workflow file applies. A rebuilt graph and a freshly loaded one SHALL therefore agree on what is valid.

#### Scenario: Round trip preserves what the run executes
- **WHEN** a graph is recorded and then rebuilt
- **THEN** the rebuilt workflow SHALL have the same nodes, node types, resolved config, per-node budgets, edges, and run settings, and its derived execution order and ancestry SHALL match the original's

#### Scenario: A recorded node type this build no longer has
- **WHEN** a recorded graph names a node type absent from the registry rebuilding it
- **THEN** the rebuild SHALL fail with an error naming the node and the type, rather than dropping the node from the graph

#### Scenario: Skills are resolved against the machine reading the graph
- **WHEN** a recorded graph naming skills is rebuilt
- **THEN** those skills SHALL be resolved from the reading machine's skill roots, because where a skill lives is a property of the machine rather than of the run

### Requirement: One writer owns a run document
Exactly one process SHALL write a given run document — the process driving that run. Every other reader of the document SHALL be read-only, and SHALL be able to determine whether the writing process is still alive.

#### Scenario: A second reader attaches to a live run
- **WHEN** a reader opens a run document that another process is driving
- **THEN** the reader SHALL reflect updates as they are written and SHALL NOT write to the document

#### Scenario: The writing process dies
- **WHEN** the process driving a run exits without the run finishing
- **THEN** a reader SHALL report that the run is no longer being driven rather than presenting the last written state as live
