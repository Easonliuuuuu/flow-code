# guest-run-reporting Specification

## Purpose

Defines how a process that is not flow-code's engine opens, advances, and closes a run: the transitions it may report, the ones the validator refuses, the ownership rule that stops it writing over an engine-owned run, and the enforcement tier every run records so a reader knows what the graph in front of them is worth. The MCP tools and the CLI are two surfaces over this one contract.

## Requirements
### Requirement: Guest run lifecycle
The system SHALL let a process that is not flow-code's engine open a run against the project's workflow, report progress through it, and close it, writing the same run-state document under `.flow-code/runs/` that an engine-driven run writes. A guest run SHALL be readable by `flow-code watch` with no viewer changes.

#### Scenario: An external agent opens a run
- **WHEN** a guest reports the start of a run for a project with a valid `.flow-code/workflow.yaml`
- **THEN** the system SHALL create a run-state document containing every node in the workflow at status `idle`, SHALL return the run's id to the guest, and a viewer attached to the repository SHALL render the graph within one poll interval

#### Scenario: A guest closes a run it opened
- **WHEN** a guest reports that its run is finished
- **THEN** the run-state document SHALL record the run as finished, and the viewer SHALL show it as finished rather than as a run whose driver disappeared

#### Scenario: A guest abandons a run without closing it
- **WHEN** a guest process exits without reporting completion
- **THEN** the run-state document SHALL remain readable and unfinished, and no subsequent guest SHALL be prevented from opening a new run

### Requirement: Node transition reporting
The system SHALL accept reported node transitions — a node starting, completing with output, or failing with a reason — and SHALL persist each one to run-state as it is reported, so a viewer's picture never lags the guest's actual progress by more than one write.

#### Scenario: A node is reported as started
- **WHEN** a guest reports that node `implement` has started
- **THEN** run-state SHALL record `implement` as `running` with a start timestamp

#### Scenario: A node is reported as complete with output
- **WHEN** a guest reports node `implement` complete, supplying output for the node type's declared output shape
- **THEN** the system SHALL validate the output against that shape, SHALL record the node as `done` with its output, and SHALL make that output available to downstream nodes exactly as an engine-driven run does

#### Scenario: Reported output does not match the node type's shape
- **WHEN** a guest reports a node complete with output that fails the node type's output schema
- **THEN** the system SHALL reject the report with an error naming the offending fields, and run-state SHALL be left unchanged

#### Scenario: A node is reported as failed
- **WHEN** a guest reports node `test` as failed with a reason
- **THEN** run-state SHALL record `test` as `error` with that reason as its status detail

### Requirement: Illegal transitions are rejected
The system SHALL validate every reported transition against the loaded workflow graph and SHALL reject transitions the graph does not permit, returning an error the guest can act on. A guest that misreports SHALL NOT be able to produce a graph that contradicts the workflow's own ordering rules.

#### Scenario: A node is started before its upstream is done
- **WHEN** a guest reports node `implement` as started while its upstream node `discuss` is still `idle`
- **THEN** the system SHALL reject the report, naming the unsatisfied upstream node, and run-state SHALL be left unchanged

#### Scenario: A node is completed without having started
- **WHEN** a guest reports node `test` as complete while run-state has it at `idle`
- **THEN** the system SHALL reject the report and run-state SHALL be left unchanged

#### Scenario: A node id that is not in the workflow is reported
- **WHEN** a guest reports a transition for a node id absent from `.flow-code/workflow.yaml`
- **THEN** the system SHALL reject the report, naming the unknown node id and listing the ids the workflow does define

### Requirement: A guest never writes over an engine-owned run
The system SHALL refuse guest reports directed at a run that flow-code's own engine owns and is still driving. Ownership is recorded in run-state, and a guest and a driver SHALL never both be writing the same run document.

#### Scenario: A guest reports against a live engine-driven run
- **WHEN** a guest reports a transition targeting a run whose recorded owner is a live `flow-code run` process
- **THEN** the system SHALL reject the report, explaining that the run is being driven by another process, and SHALL NOT modify that run's document

#### Scenario: A guest opens a run while an engine-driven run is in progress
- **WHEN** a guest opens a run while an engine-driven run is already active in the same repository
- **THEN** the system SHALL either refuse or create a separate run document, and SHALL NOT merge the guest's reports into the engine's run

### Requirement: Every run records its enforcement tier and absent guarantees
Run-state SHALL record which enforcement tier a run ran under — flow-code's engine executing it, a host session with flow-code's enforcement active, or self-reporting with no enforcement — together with the guarantees that tier does not provide. Consumers of run-state SHALL be able to tell the three apart without inspecting a run's contents heuristically.

#### Scenario: The tier is readable from the run document
- **WHEN** a run's state document is read by any consumer
- **THEN** it SHALL name the run's enforcement tier and the reporting surface used

#### Scenario: Absent guarantees are enumerated, not implied
- **WHEN** a run's tier does not provide a guarantee an engine-driven run provides — capability enforcement, per-node model selection, exact token accounting, or engine-driven loop-back routing
- **THEN** run-state SHALL name that guarantee as absent for the run, rather than leaving it to a consumer to infer from the tier

#### Scenario: A run does not claim enforcement it never had
- **WHEN** a run completes at the self-reported tier
- **THEN** its run-state SHALL NOT contain capability-denial records or token totals presented as if a harness had produced them

#### Scenario: An engine-driven run is unchanged
- **WHEN** a run is driven by `flow-code run`
- **THEN** it SHALL record the engine tier with no absent guarantees, and every other field SHALL be exactly what it was before this change

### Requirement: The MCP and CLI surfaces are equivalent
The system SHALL expose the same reporting operations over an MCP server and over `flow-code node …` CLI subcommands, with identical validation and identical effects on run-state. A workflow driven entirely through one surface SHALL produce the same run-state as the same workflow driven through the other.

#### Scenario: The same run driven over either surface
- **WHEN** an identical sequence of transitions is reported once entirely over MCP and once entirely over the CLI
- **THEN** the two resulting run-state documents SHALL be equivalent apart from run id, timestamps, and the recorded reporting surface

#### Scenario: A rejection is reported identically on both surfaces
- **WHEN** an illegal transition is reported over MCP and the same illegal transition is reported over the CLI
- **THEN** both SHALL be rejected for the same stated reason, and the CLI SHALL exit non-zero
