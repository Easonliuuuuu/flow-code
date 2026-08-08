# project-documentation

## Purpose

What the repository has to explain about itself, to two different readers: someone
deciding whether to use flow-code, and someone about to change it. Covers which
documents must exist and what each must cover — not their wording — plus the rule
that separates documentation written by hand from documentation generated from
the code it describes.

## Requirements

### Requirement: README describes what the project is
The repository SHALL have a `README.md` at its root that states in the first section what flow-code is, in terms a reader unfamiliar with the project can understand without reading source code.

#### Scenario: New reader opens the README
- **WHEN** a reader with no prior context opens `README.md`
- **THEN** the first section describes flow-code as a terminal-native node-graph interface for running and observing agentic coding workflows

### Requirement: README provides a quickstart
The README SHALL include a quickstart covering how to install the tool and run it, using only commands that exist — a published package install for a reader who wants to use it, and a from-source path for a reader who wants to change it.

#### Scenario: Reader wants to try the tool
- **WHEN** a reader follows the quickstart's commands in order
- **THEN** they end up with the CLI runnable, using only commands that exist as published entry points or as scripts in `package.json`

### Requirement: README does not restate the workflow-config schema
The README SHALL NOT document the workflow-definition YAML field by field. It MAY show a minimal example graph, and SHALL point to the reference documentation as the source of truth for everything the format accepts.

#### Scenario: Reader wants the config file format
- **WHEN** a reader looks for how to write a workflow-definition YAML file
- **THEN** the README links to the workflow and node-type references rather than duplicating field-by-field documentation

### Requirement: Reference documentation derived from code is generated, not written
Documentation that restates something the code already declares SHALL be generated from that declaration and checked, rather than maintained by hand. Hand-written prose SHALL be reserved for what the code cannot state: intent, trade-offs, and how the pieces fit.

#### Scenario: A node type gains a config field
- **WHEN** a node type's configuration changes in the registry
- **THEN** its entry in the node type reference changes by regeneration, and a change that skips regeneration fails the check rather than shipping stale documentation

### Requirement: The contribution workflow is documented, with its enforcement limits stated
The repository SHALL document how a change gets from a working copy to `main` — development setup, the branch → pull request → green CI → merge convention — and SHALL state plainly which parts of that are enforced automatically and which are convention only.

#### Scenario: Contributor looks for how to contribute
- **WHEN** a contributor opens the README
- **THEN** it points them to the contribution documentation rather than duplicating it

#### Scenario: Contributor reads the contribution documentation
- **WHEN** a contributor reads it
- **THEN** it describes the branch → pull request → green CI → merge convention, and states explicitly that no branch protection rule is configured, so nothing server-side blocks a direct push to `main` or a merge with a failing check

### Requirement: A contributor can find out what is being built and why
The repository SHALL carry, above the change-level documentation, a statement of what the product is trying to achieve and a derived view of where it actually is. The intent portion SHALL be hand-written and hold no status; the status portion SHALL be generated, and SHALL NOT be hand-editable in practice.

#### Scenario: Contributor wants the goal behind a change
- **WHEN** a contributor reads the contribution documentation
- **THEN** it points them to the product brief, the roadmap of business requirements, and the ledger that maps shipped work to them

#### Scenario: Status is asked to reflect reality
- **WHEN** the status rollup is regenerated
- **THEN** every figure in it is derived from the repository — specs, source modules, and commit history — and none is a value someone typed in

#### Scenario: Someone edits the generated status file
- **WHEN** the status rollup is edited by hand and committed
- **THEN** the check fails, because the file no longer matches what the repository derives
