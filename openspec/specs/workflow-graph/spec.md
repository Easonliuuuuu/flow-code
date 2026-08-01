# workflow-graph Specification

## Purpose

Defines the workflow definition file (`.flow-code/workflow.yaml`), its scaffolding via `flow-code init`, parsing and validation of nodes, edges, and run settings, and the built-in node type registry with its capability model.

## Requirements

### Requirement: Default workflow scaffold
The system SHALL provide an `init` command that scaffolds a default workflow definition file (`.flow-code/workflow.yaml`) in the current repo when one does not already exist, containing a working Discuss → Implement → Test → Validate → Review → Approval-Gate → Git-ops graph.

#### Scenario: Init in a repo with no existing workflow file
- **WHEN** the user runs `flow-code init` in a git repo that has no `.flow-code/workflow.yaml`
- **THEN** the system creates `.flow-code/workflow.yaml` with a valid default graph and reports the file was created

#### Scenario: Default graph gates the git-mutating step
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the graph SHALL contain an Approval-Gate node between the Review node and the Git-ops node, so the "nothing is pushed without explicit approval" guarantee holds with zero configuration

#### Scenario: Init in a repo that already has a workflow file
- **WHEN** the user runs `flow-code init` in a repo that already has `.flow-code/workflow.yaml`
- **THEN** the system SHALL NOT overwrite the existing file and SHALL inform the user it already exists

### Requirement: Workflow file parsing and validation
The system SHALL parse `.flow-code/workflow.yaml` and validate every node's `type` against the built-in node type registry and every node's `config` against that type's schema before running.

#### Scenario: Valid workflow file
- **WHEN** the user runs `flow-code run` with a workflow file containing only known node types and valid config for each
- **THEN** the system loads the graph successfully and proceeds to execution

#### Scenario: Unknown node type
- **WHEN** the workflow file references a node `type` that is not in the built-in registry
- **THEN** the system SHALL fail before starting execution with an error naming the offending node id and the unknown type

#### Scenario: Invalid node config
- **WHEN** a node's `config` fails validation against its type's schema
- **THEN** the system SHALL fail before starting execution with an error naming the node id and the specific config field that failed

### Requirement: Run settings block
The workflow file SHALL support a top-level `settings` block carrying run-wide configuration that is not specific to any node, including the concurrency cap and the default model, validated before execution like any node config.

#### Scenario: Settings omitted
- **WHEN** the workflow file contains no `settings` block
- **THEN** the system SHALL apply documented defaults for every setting and start normally

#### Scenario: Invalid setting value
- **WHEN** the `settings` block contains an unknown key or a value failing its schema
- **THEN** the system SHALL fail before starting execution with an error naming the setting and why it failed

### Requirement: Graph structural validation
The system SHALL validate that the workflow graph is a directed acyclic graph with no dangling edges before execution.

#### Scenario: Cycle in graph
- **WHEN** the workflow file's edges form a cycle
- **THEN** the system SHALL fail before starting execution with an error identifying the nodes involved in the cycle

#### Scenario: Edge references unknown node
- **WHEN** an edge's `from` or `to` references a node id not defined in the `nodes` list
- **THEN** the system SHALL fail before starting execution with an error naming the invalid edge

### Requirement: Edges carry no behavior
Edges in the workflow file SHALL declare only `from` and `to`. All blocking, gating, and approval behavior SHALL be expressed by placing nodes on the graph, never by annotating edges.

#### Scenario: Gating an arbitrary transition
- **WHEN** the user wants a transition between two arbitrary nodes to require approval
- **THEN** the user SHALL express this by inserting an Approval-Gate node between them, and the system SHALL enforce the gate identically regardless of which node types sit on either side

#### Scenario: Unrecognized edge property
- **WHEN** an edge declares any property other than `from` or `to`
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the unrecognized property

### Requirement: Built-in node type registry
The system SHALL expose a registry of built-in node types (Discuss, Implement, Test, Validate, Review, Git-ops, Worktree-Agent, Approval-Gate). Each type SHALL be defined by a capability set, a default role prompt, and an output schema, in addition to its config schema.

#### Scenario: Listing available node types
- **WHEN** the user runs `flow-code node-types`
- **THEN** the system prints every built-in node type's id, its capability set, a short description of its config schema, and the shape of its output

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

### Requirement: Test node runs deterministic commands
The Test node type SHALL execute a configured list of shell commands and report their results without invoking an agent session, distinguishing it from Validate (agent-driven conformance check against the task intent) and Review (agent-driven quality critique).

#### Scenario: Test node executes configured commands
- **WHEN** a Test node whose config lists one or more commands is started
- **THEN** the system SHALL run each command in order in the node's working directory, record each command's exit status and output, and consume no Claude Agent SDK session and no API tokens

#### Scenario: A configured command fails
- **WHEN** any command configured on a Test node exits non-zero
- **THEN** the node SHALL emit `error`, and its output SHALL identify which command failed and with what exit status

### Requirement: Git-ops node configuration
The Git-ops node type SHALL declare an explicit config schema covering which git operations it performs, and pushing SHALL be opt-in rather than implied by the node's presence in the graph.

#### Scenario: Default Git-ops configuration commits only
- **WHEN** a Git-ops node is declared with no push configuration
- **THEN** the node SHALL commit the pending changes on the current branch and SHALL NOT push to any remote

#### Scenario: Pushing is explicitly configured
- **WHEN** a Git-ops node's config enables pushing
- **THEN** the config SHALL name the remote and the target branch, and validation SHALL fail before execution if either is missing

#### Scenario: Push target is reported before the gate
- **WHEN** a Git-ops node is downstream of an Approval-Gate and configured to push
- **THEN** the gate's detail view SHALL state the remote and branch that will be pushed to on approval
