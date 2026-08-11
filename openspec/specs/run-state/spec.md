# run-state Specification

## Purpose

Defines the run document at `.flow-code/runs/<runId>.json`: the graph it records so a run describes itself without the workflow file, the rules that keep exactly one process writing it, what a reader may conclude about whether that process is still alive, and how a run survives interruption, concurrency, and a process that dies badly. It is the seam every other consumer sits on — the viewer, the status line, resume, and worktree reclamation all read this and nothing else.

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
Exactly one process SHALL write a given run document — the process driving that run. Ownership SHALL be recorded in the document and verified by the writer before each write, so that a second writer is refused rather than merely absent. Every other reader of the document SHALL be read-only, and SHALL be able to determine whether the writing process is still alive.

#### Scenario: A second reader attaches to a live run
- **WHEN** a reader opens a run document that another process is driving
- **THEN** the reader SHALL reflect updates as they are written and SHALL NOT write to the document

#### Scenario: The writing process dies
- **WHEN** the process driving a run exits without the run finishing
- **THEN** a reader SHALL report that the run is no longer being driven rather than presenting the last written state as live

#### Scenario: A second writer attempts to write a run it does not own
- **WHEN** a process attempts to write a run document whose recorded owner is not that process
- **THEN** the write SHALL be refused, the document SHALL be left byte-identical, and the refusal SHALL name the run and the fact that it is owned elsewhere

#### Scenario: Ownership is checked against the document, not assumed from startup
- **WHEN** a process that owned a run document writes to it after another process has replaced its ownership
- **THEN** the write SHALL be refused rather than overwriting the new owner's state

#### Scenario: A refused write is reported, never dropped
- **WHEN** a writer's ownership check fails during a run
- **THEN** the system SHALL surface the failure and SHALL NOT continue as though the run's state were still being recorded

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

### Requirement: Ownership transfers explicitly
A process resuming a run SHALL take ownership of that run's document as a recorded act, and SHALL be refused when the run's current owner is still alive. Continuing a run under its original id SHALL NOT silently overwrite another process's ownership.

#### Scenario: Resuming a run whose owner is gone
- **WHEN** a run is resumed while its recorded owner is no longer alive
- **THEN** the resuming process SHALL become the recorded owner, and its subsequent writes SHALL be accepted

#### Scenario: Resuming a run that is still being driven
- **WHEN** a run is resumed while its recorded owner is still alive
- **THEN** the system SHALL refuse to take ownership and SHALL report that the run is already being driven

#### Scenario: The previous owner is preserved, not erased
- **WHEN** ownership of a run transfers
- **THEN** the document SHALL record that a transfer occurred, so a reader can tell a resumed run from one driven by a single process throughout

### Requirement: Liveness distinguishes unknowable from dead
The system SHALL report a run's driver as alive, not alive, or of unknowable status, and SHALL NOT collapse the unknowable case into either of the others. Liveness SHALL be unknowable when the document was written by a machine other than the one reading it, and when the document records no owner identity to check.

#### Scenario: A run written on another machine
- **WHEN** a reader opens a run document recorded as owned by a different machine
- **THEN** the system SHALL report the driver's status as unknowable, and SHALL NOT report the run as either live or abandoned

#### Scenario: A run document written before ownership was recorded
- **WHEN** a reader opens a run document that carries no owner identity
- **THEN** the system SHALL report the driver's status as unknowable rather than inferring it

#### Scenario: Unknowable status never authorizes reclamation
- **WHEN** an operation would reclaim or delete resources belonging to a run — worktrees, branches, or any other artifact — and that run's driver status is unknowable
- **THEN** the system SHALL NOT treat the run as abandoned for the purpose of that reclamation

### Requirement: A run that died badly is described as such
A reader SHALL be able to distinguish a run that finished, a run that was interrupted cleanly, a run still being driven, and a run whose driver disappeared without finishing it.

#### Scenario: The driver was killed without running its shutdown path
- **WHEN** a reader opens an unfinished run document whose owner is not alive
- **THEN** the system SHALL describe the run as having stopped without finishing, distinctly from a run that was interrupted cleanly

#### Scenario: A cleanly interrupted run
- **WHEN** a reader opens a run that recorded a clean interruption
- **THEN** the system SHALL describe it as interrupted, and it SHALL remain resumable

### Requirement: A reader with no run id gets a defined answer
A reader that attaches without naming a run SHALL attach to the single live run when exactly one exists, and SHALL report the ambiguity when several runs are live rather than choosing between them silently.

#### Scenario: Exactly one live run
- **WHEN** a reader attaches without naming a run and one run is live
- **THEN** it SHALL attach to that run

#### Scenario: Several runs are live at once
- **WHEN** a reader attaches without naming a run and more than one run is live
- **THEN** the system SHALL make the ambiguity visible rather than presenting one of them as the run, and a reader with room to do so SHALL identify the candidates

#### Scenario: No live run
- **WHEN** a reader attaches without naming a run and no run is live
- **THEN** the system SHALL attach to the most recent run and SHALL NOT present it as being driven

### Requirement: A crash mid-write leaves the previous document intact
Writing a run document SHALL replace it atomically. A process that dies partway through a write SHALL leave the previously written document readable, and SHALL NOT leave a partially written document in its place.

#### Scenario: The writer dies during a write
- **WHEN** the writing process is killed while a run document is being written
- **THEN** the run document at its published path SHALL still parse, and SHALL contain the state as of the last completed write

#### Scenario: No partial document is ever published
- **WHEN** a run document is written
- **THEN** at no point SHALL a reader observe the document at its published path in a partially written state
