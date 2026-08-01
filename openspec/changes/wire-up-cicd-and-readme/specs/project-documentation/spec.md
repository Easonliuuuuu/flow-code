## ADDED Requirements

### Requirement: README describes what the project is
The repository SHALL have a `README.md` at its root that states in the first section what flow-code is, in terms a reader unfamiliar with the project can understand without reading source code.

#### Scenario: New reader opens the README
- **WHEN** a reader with no prior context opens `README.md`
- **THEN** the first section describes flow-code as a terminal-native node-graph interface for running and observing agentic coding workflows

### Requirement: README provides a quickstart
The README SHALL include a quickstart section covering install, build, and how to run the CLI locally, using the scripts already defined in `package.json`.

#### Scenario: Reader wants to try the tool
- **WHEN** a reader follows the quickstart section's commands in order
- **THEN** they end up with the project built and the `flow-code` CLI runnable, using only commands that exist in `package.json`'s `scripts`

### Requirement: README defers the workflow-config schema to specs
The README SHALL NOT restate the workflow-definition YAML schema in prose; it SHALL instead point to `openspec/specs/workflow-graph/spec.md` as the source of truth.

#### Scenario: Reader wants the config file format
- **WHEN** a reader looks for how to write a workflow-definition YAML file
- **THEN** the README links to `openspec/specs/workflow-graph/spec.md` rather than duplicating field-by-field documentation

### Requirement: README documents the contribution workflow and its enforcement limits
The README SHALL document the feature-branch → pull-request → CI-green → merge convention, and SHALL state that this convention is not enforced by GitHub branch protection because the repository is private on a plan where branch protection is unavailable.

#### Scenario: Contributor reads the contributing section
- **WHEN** a contributor reads the README's contributing section
- **THEN** it describes creating a feature branch, opening a pull request, and merging only once CI is green, and explicitly notes that nothing server-side currently blocks a direct push to `main` or a merge with a failing check
