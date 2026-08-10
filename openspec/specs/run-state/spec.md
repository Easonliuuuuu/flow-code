# run-state Specification

## Purpose
TBD - created by archiving change add-workflow-validation-and-recorded-graph. Update Purpose after archive.
## Requirements
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

### Requirement: A reader describes a run from its own document
A reader of a run document SHALL render and describe the run from the graph that document records, without loading `.flow-code/workflow.yaml`.

#### Scenario: Reader needs no access to the workflow file
- **WHEN** a reader opens a run document while `.flow-code/workflow.yaml` is absent, unreadable, or has been replaced since the run started
- **THEN** the reader SHALL still render the graph the run recorded, and SHALL NOT substitute the current contents of the workflow file for it

#### Scenario: A run document carrying no recorded graph
- **WHEN** a reader opens a run document written before runs recorded their own shape
- **THEN** the reader SHALL report that the run's shape is unavailable, and SHALL NOT infer it from the current workflow file

#### Scenario: Node state is interpreted against the recorded graph
- **WHEN** a reader loads a run document
- **THEN** every node it renders SHALL come from the recorded graph, and no node id from any other source SHALL be reconciled into the run's state

### Requirement: In-place node edits update the recorded graph
When a node's settings are changed during a run — its model, its skills, its budget, or its test commands — the change SHALL be applied to the graph recorded in the run document as well as to `.flow-code/workflow.yaml`, through a single path that cannot update one without the other.

#### Scenario: Changing a node's model mid-run
- **WHEN** a node's model is changed while the run is in progress
- **THEN** the recorded graph SHALL reflect the new model, and a reader attached to the run SHALL see it without reloading the workflow file

#### Scenario: Edit targets a node the recorded graph does not contain
- **WHEN** an edit names a node id absent from the recorded graph
- **THEN** the system SHALL reject the edit with an error naming the node id, rather than writing a change that describes no node in this run

### Requirement: Resuming a run uses the graph the run recorded
Resuming an interrupted run SHALL execute the graph recorded in that run's document, not the current contents of `.flow-code/workflow.yaml`.

#### Scenario: Workflow file changed between interruption and resume
- **WHEN** a run is interrupted, `.flow-code/workflow.yaml` is then edited, and the run is resumed
- **THEN** the resumed run SHALL execute the recorded graph, and completed node state SHALL remain attributed to the nodes that produced it

#### Scenario: Resume reports the graph it is continuing
- **WHEN** a run is resumed
- **THEN** the system SHALL make clear that it is continuing the recorded graph, so a diverged workflow file is a visible fact rather than a silent one

