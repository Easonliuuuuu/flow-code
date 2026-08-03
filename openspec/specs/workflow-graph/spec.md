# workflow-graph Specification

## Purpose

Defines the workflow definition file (`.flow-code/workflow.yaml`), its scaffolding via `flow-code init`, parsing and validation of nodes, edges, and run settings, and the built-in node type registry with its capability model.

## Requirements

### Requirement: Default workflow scaffold
The system SHALL provide an `init` command that scaffolds a default workflow definition file (`.flow-code/workflow.yaml`) in the current repo when one does not already exist, containing a working Discuss → Implement → Test → Validate → Review → Approval-Gate → Git-ops graph. The scaffolded graph SHALL declare loop-back edges from each verification node back to Implement, so iteration on a failed check is the zero-configuration default rather than an opt-in.

#### Scenario: Init in a repo with no existing workflow file
- **WHEN** the user runs `flow-code init` in a git repo that has no `.flow-code/workflow.yaml`
- **THEN** the system creates `.flow-code/workflow.yaml` with a valid default graph and reports the file was created

#### Scenario: Default graph gates the git-mutating step
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the graph SHALL contain an Approval-Gate node between the Review node and the Git-ops node, so the "nothing is pushed without explicit approval" guarantee holds with zero configuration

#### Scenario: Default graph iterates on a failed check
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the graph SHALL contain loop-back edges from Test, Validate, and Review back to Implement with a bounded attempt count, so a failing check returns to Implement with the failure as context instead of ending the run

#### Scenario: Default graph does not retry a rejected gate
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the Approval-Gate node SHALL have no loop-back edge, because a rejection is a user decision to stop rather than a failure to retry

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
The system SHALL validate, before execution, that the workflow graph has no dangling edges and that its forward edges form a directed acyclic graph. Loop-back edges are exempt from the acyclicity check and SHALL instead be validated as pointing to a node that is an ancestor of the edge's source over the forward-edge subgraph.

#### Scenario: Cycle in graph
- **WHEN** the workflow file's forward edges form a cycle
- **THEN** the system SHALL fail before starting execution with an error identifying the nodes involved in the cycle

#### Scenario: Edge references unknown node
- **WHEN** an edge's `from` or `to` references a node id not defined in the `nodes` list
- **THEN** the system SHALL fail before starting execution with an error naming the invalid edge

#### Scenario: Loop-back edge does not create a validation cycle
- **WHEN** the workflow file declares a loop-back edge from a node to one of its forward-edge ancestors
- **THEN** the system SHALL accept the graph and compute a topological order over the forward edges alone

#### Scenario: Loop-back edge does not target an ancestor
- **WHEN** a loop-back edge's target is not an ancestor of its source over the forward-edge subgraph
- **THEN** the system SHALL fail before starting execution with an error naming the edge and stating that a loop-back must point back to an upstream node

### Requirement: Edges carry no behavior
Edges in the workflow file SHALL declare only graph structure: `from`, `to`, and — for loop-back edges — the declaration that the edge is a loop-back together with its attempt bound. All blocking, gating, and approval behavior SHALL be expressed by placing nodes on the graph, never by annotating edges. Whether a node succeeds or fails SHALL be determined by its node type, never by an edge.

#### Scenario: Gating an arbitrary transition
- **WHEN** the user wants a transition between two arbitrary nodes to require approval
- **THEN** the user SHALL express this by inserting an Approval-Gate node between them, and the system SHALL enforce the gate identically regardless of which node types sit on either side

#### Scenario: Unrecognized edge property
- **WHEN** an edge declares any property other than `from`, `to`, and the loop-back declaration with its attempt bound
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the unrecognized property

#### Scenario: An edge cannot decide success or failure
- **WHEN** an edge attempts to declare a condition, predicate, or verdict governing whether its source node succeeded
- **THEN** the system SHALL fail before starting execution, because that determination belongs to the node type

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

### Requirement: Loop-back edge declaration
The workflow file SHALL allow an edge to be declared as a loop-back, naming the upstream node to return to and the maximum number of attempts permitted, validated before execution like any other part of the file.

#### Scenario: Declaring a loop-back
- **WHEN** the workflow file declares an edge marked as a loop-back with a target node and a maximum attempt count
- **THEN** the system SHALL accept it and SHALL treat that edge as a return path rather than a dependency, so the target does not wait on the source before first running

#### Scenario: Loop-back without an attempt bound
- **WHEN** a loop-back edge is declared without a maximum attempt count
- **THEN** the system SHALL apply a documented default bound rather than allowing an unbounded loop

#### Scenario: Invalid attempt bound
- **WHEN** a loop-back edge declares a maximum attempt count that is not a positive integer
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the invalid value

#### Scenario: Loop-backs do not affect dependency readiness
- **WHEN** the engine determines whether a node's dependencies are satisfied
- **THEN** loop-back edges SHALL be excluded from that determination, so a loop-back into a node does not prevent that node from running on the first pass

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
