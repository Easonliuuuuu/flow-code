## ADDED Requirements

### Requirement: Validation is reachable without starting a run
The system SHALL provide a `validate` command that loads `.flow-code/workflow.yaml`, applies every check the system applies before execution — node types, node config schemas, the settings block, and graph structure — and reports the result without running any node, starting any agent session, or writing a run document. The command SHALL exit non-zero when any check fails and zero when all pass.

#### Scenario: A valid workflow file
- **WHEN** the user runs `flow-code validate` in a repo whose workflow file passes every check
- **THEN** the system SHALL report the file as valid, exit zero, and SHALL NOT create a run document or start any session

#### Scenario: An invalid workflow file
- **WHEN** the user runs `flow-code validate` in a repo whose workflow file fails one or more checks
- **THEN** the system SHALL exit non-zero and report each failure with the node id, edge, or setting responsible

#### Scenario: No workflow file
- **WHEN** the user runs `flow-code validate` in a repo with no `.flow-code/workflow.yaml`
- **THEN** the system SHALL exit non-zero and say the file is missing and how to create it

### Requirement: Validation reports every failure it can find
Validation SHALL report all independent failures it can detect in one pass rather than stopping at the first. Checks that cannot run because an earlier failure makes them meaningless SHALL be reported as not evaluated rather than reported as passing.

#### Scenario: Several independent failures
- **WHEN** a workflow file contains an unknown node type, a node whose config fails its schema, and an edge referencing an undefined node
- **THEN** validation SHALL report all three, each naming what is responsible, rather than reporting only the first

#### Scenario: Independent structural failures
- **WHEN** a workflow file contains both a loop-back that does not point at an ancestor and an edge condition reading a node it cannot see
- **THEN** validation SHALL report both, because neither check depends on the other having passed

#### Scenario: A failure that blocks a later check
- **WHEN** a workflow file fails to parse as YAML
- **THEN** validation SHALL report the parse failure and SHALL report the structural checks as not evaluated, rather than reporting them as passing

#### Scenario: Validation and execution agree
- **WHEN** `flow-code validate` reports a workflow file as valid
- **THEN** starting a run against that unchanged file SHALL NOT fail any pre-execution check, because both use the same checks
