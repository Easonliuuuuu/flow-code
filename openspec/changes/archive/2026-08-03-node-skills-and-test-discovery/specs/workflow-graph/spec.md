## ADDED Requirements

### Requirement: Workflow presets
The `init` command SHALL accept a named preset that scaffolds a workflow other than the default graph, so a project can start from a workflow shaped around an existing methodology rather than editing the default graph into one. Presets SHALL produce a workflow file that passes the same validation as any hand-written one, and the absence of a preset SHALL scaffold the default graph unchanged.

#### Scenario: Init with no preset
- **WHEN** the user runs `flow-code init` without naming a preset
- **THEN** the system SHALL scaffold the default Discuss → Spec → Implement → Test → Validate → Review → Approval-Gate → Git-ops graph

#### Scenario: Init with the openspec preset
- **WHEN** the user runs `flow-code init` naming the openspec preset
- **THEN** the system SHALL scaffold an explore → propose → apply → gate → archive graph built from the Discuss, Spec, Implement, Approval-Gate, and Git-ops node types, with the corresponding openspec skills attached to each agent-driven node

#### Scenario: A preset's skills are not installed
- **WHEN** a preset attaches skills that do not resolve in any discovery root
- **THEN** `init` SHALL scaffold the file and SHALL warn which skills are missing and where they are expected, rather than writing a workflow that silently fails to load

#### Scenario: An unknown preset name
- **WHEN** the user names a preset that does not exist
- **THEN** the system SHALL fail with an error listing the available preset names and SHALL NOT create or modify a workflow file

## MODIFIED Requirements

### Requirement: Built-in node type registry
The system SHALL expose a registry of built-in node types (Discuss, Implement, Test, Validate, Review, Git-ops, Worktree-Agent, Approval-Gate). Each type SHALL be defined by a capability set, a default role prompt, an output schema, and whether the type is interactive, in addition to its config schema. A type MAY additionally declare that it is context-transparent and MAY declare a failure predicate over its own output.

#### Scenario: Listing available node types
- **WHEN** the user runs `flow-code node-types`
- **THEN** the system prints every built-in node type's id, its capability set, whether it is agent-driven and whether it is interactive, a short description of its config schema, and the shape of its output

#### Scenario: Every type declares a capability set
- **WHEN** a node type is registered
- **THEN** it SHALL declare the capabilities its execution is permitted to use, drawn from `read`, `edit`, `exec`, `git-read`, and `git-write`

#### Scenario: No node type has network access
- **WHEN** any built-in node type is registered
- **THEN** its capability set SHALL NOT grant network access, and network-capable tools SHALL be unavailable to every agent session in this version

#### Scenario: Verification node types cannot edit
- **WHEN** the Test, Validate, or Review node types are registered
- **THEN** their capability sets SHALL NOT include `edit`, so a verification step cannot satisfy its own criteria by modifying the code or the tests it is checking

#### Scenario: Only Git-ops may write to git
- **WHEN** any node type other than Git-ops is registered
- **THEN** its capability set SHALL NOT include `git-write`

#### Scenario: Verification types declare a failure predicate
- **WHEN** the Validate and Review node types are registered
- **THEN** each SHALL declare a failure predicate that holds when its recorded output carries a `fail` verdict

#### Scenario: Approval-Gate is context-transparent
- **WHEN** the Approval-Gate node type is registered
- **THEN** it SHALL be declared context-transparent, so placing a gate on the graph does not sever the context chain across it

#### Scenario: Every type declares whether it is interactive
- **WHEN** a node type is registered
- **THEN** it SHALL declare whether it is interactive, and only the Discuss type SHALL be

#### Scenario: Only agent-driven types accept skills
- **WHEN** a node type's config schema is registered
- **THEN** it SHALL accept a `skills` list if and only if the type is agent-driven

### Requirement: Test node runs deterministic commands
The Test node type SHALL execute a configured list of shell commands and report their results without invoking an agent session, distinguishing it from Validate (agent-driven conformance check against the task intent) and Review (agent-driven quality critique). A Test node MAY instead be configured to rediscover its commands at the start of each execution, which is opt-in and constrained by the test-command-discovery capability.

#### Scenario: Test node executes configured commands
- **WHEN** a Test node whose config lists one or more commands is started
- **THEN** the system SHALL run each command in order in the node's working directory, record each command's exit status and output, and consume no Claude Agent SDK session and no API tokens

#### Scenario: A configured command fails
- **WHEN** any command configured on a Test node exits non-zero
- **THEN** the node SHALL emit `error`, and its output SHALL identify which command failed and with what exit status

#### Scenario: Authoring tests belongs to Implement
- **WHEN** the Implement node type's role prompt is composed
- **THEN** it SHALL state that Implement owns the tests covering its change and that the downstream Test node only runs commands and cannot author a test, so no test the change needs is left unwritten on the assumption that a later node will write it

#### Scenario: Test config accepts a rediscovery marker
- **WHEN** a Test node's config is validated
- **THEN** the schema SHALL accept either a non-empty list of command strings or the `auto` marker, and nothing else
