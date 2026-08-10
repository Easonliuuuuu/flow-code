## ADDED Requirements

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
