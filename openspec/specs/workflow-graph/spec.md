# workflow-graph Specification

## Purpose

Defines the workflow definition file (`.flow-code/workflow.yaml`), its scaffolding via `flow-code init`, parsing and validation of nodes, edges, and run settings, and the built-in node type registry with its capability model.
## Requirements
### Requirement: Default workflow scaffold
The system SHALL provide an `init` command that scaffolds a default workflow definition file (`.flow-code/workflow.yaml`) in the current repo when one does not already exist, containing a working Discuss → Spec → Approval-Gate → Implement → Test → Validate → Review → Approval-Gate → Git-ops graph. The scaffolded graph SHALL declare loop-back edges from each verification node back to Implement, so iteration on a failed check is the zero-configuration default rather than an opt-in.

The scaffolded graph SHALL gate the spec as well as the push. The spec is the contract every downstream node is judged against and is fixed before any code is written, so the run SHALL NOT adopt it without an explicit human decision.

#### Scenario: Init in a repo with no existing workflow file
- **WHEN** the user runs `flow-code init` in a git repo that has no `.flow-code/workflow.yaml`
- **THEN** the system creates `.flow-code/workflow.yaml` with a valid default graph and reports the file was created

#### Scenario: Default graph gates the git-mutating step
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the graph SHALL contain an Approval-Gate node between the Review node and the Git-ops node, so the "nothing is pushed without explicit approval" guarantee holds with zero configuration

#### Scenario: Default graph gates the spec
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the graph SHALL contain an Approval-Gate node between the Spec node and the Implement node, so no code is written against a contract no one has read

#### Scenario: A rejected spec is reconsidered rather than ending the run
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the spec gate SHALL declare a loop-back edge to the Discuss node upstream of the Spec node, so rejecting the spec reopens the discussion that produced it and re-runs Spec with the user's reason, rather than ending the run

#### Scenario: Default graph iterates on a failed check
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the graph SHALL contain loop-back edges from Test, Validate, and Review back to Implement with a bounded attempt count, so a failing check returns to Implement with the failure as context instead of ending the run

#### Scenario: Default graph stops on a rejected final gate
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the Approval-Gate node before Git-ops SHALL have no loop-back edge and no rejection branch, so rejecting the finished work ends the run by default; the file SHALL document, without enabling, how to route that rejection to a revision step instead. This SHALL NOT apply to the spec gate, whose loop-back is scaffolded rather than documented, because a spec is rejected to be rewritten whereas finished work is rejected to be abandoned.

#### Scenario: A scaffolded run is no longer unattended end to end
- **WHEN** a run executes a newly scaffolded default workflow
- **THEN** it SHALL stop for a human decision before Implement as well as before Git-ops, and the scaffolded file SHALL say so, so that the loss of unattended end-to-end execution is a stated property of the default rather than a surprise

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

### Requirement: Edges route, node types judge
An edge in the workflow file SHALL be able to decide whether a path carries, and SHALL NOT be able to decide whether the node it leaves succeeded or failed. An edge MAY declare a routing condition guarding whether its target runs, and a loop-back edge MAY declare which outcome takes it; neither SHALL determine that outcome. Blocking, gating, and approval SHALL be expressed by placing nodes on the graph rather than by annotating edges.

The recognized edge properties SHALL be exactly those the edge schema accepts, and an edge declaring anything else SHALL be rejected before execution.

#### Scenario: Gating an arbitrary transition
- **WHEN** the user wants a transition between two arbitrary nodes to require approval
- **THEN** the user SHALL express this by inserting an Approval-Gate node between them, and the system SHALL enforce the gate identically regardless of which node types sit on either side

#### Scenario: Unrecognized edge property
- **WHEN** an edge declares any property other than `from`, `to`, `when`, and the loop-back declaration with its attempt bound and its trigger
- **THEN** the system SHALL fail before starting execution with an error naming the edge and the unrecognized property

#### Scenario: A routing condition is a recognized property
- **WHEN** an edge declares a `when` condition
- **THEN** the system SHALL accept it and evaluate it to decide whether the edge carries, rather than rejecting the edge as carrying an unrecognized property

#### Scenario: An edge cannot decide success or failure
- **WHEN** an edge attempts to declare a condition, predicate, or verdict governing whether its source node succeeded
- **THEN** the system SHALL fail before starting execution, because that determination belongs to the node type

#### Scenario: Routing does not become judging
- **WHEN** an edge's routing condition does not hold, or a loop-back's declared trigger does not match how its source ended
- **THEN** the system SHALL leave the source node's recorded status exactly as its node type determined it, and SHALL express the routing decision only in whether the path is taken

### Requirement: Unconditional edges out of an Approval-Gate are conditioned on approval
When a workflow declares a forward edge whose source is an Approval-Gate and which states no condition, the system SHALL evaluate that edge as though it required the gate's decision to be `approved`. The workflow file on disk SHALL NOT be rewritten, and an edge that states its own condition SHALL be left exactly as written.

#### Scenario: An existing workflow with an unconditional gate edge
- **WHEN** a workflow declares `gate → git-ops` with no condition and the gate is rejected
- **THEN** the system SHALL skip `git-ops`, so a workflow written before rejection branches existed retains its original behavior with no edit

#### Scenario: An explicitly conditioned edge is untouched
- **WHEN** a workflow declares an edge out of an Approval-Gate that states its own condition
- **THEN** the system SHALL evaluate exactly the stated condition and SHALL NOT add or replace one

#### Scenario: Edges out of other node types are unaffected
- **WHEN** a workflow declares an unconditional forward edge whose source is not an Approval-Gate
- **THEN** the system SHALL evaluate it as unconditional

#### Scenario: A loop-back out of a gate carries no condition
- **WHEN** a workflow declares a loop-back edge whose source is an Approval-Gate
- **THEN** the system SHALL NOT attach a condition to it, because a loop-back is a return path taken on how its source ended rather than a routed forward edge

### Requirement: A loop-back declares which outcome takes it
A loop-back edge SHALL declare whether it is taken when its source fails or when its source completes, defaulting to failure. Whether a node succeeded or failed SHALL remain the node type's call; the edge only says where each outcome routes.

#### Scenario: The default is failure
- **WHEN** a workflow declares a loop-back without stating which outcome takes it
- **THEN** the system SHALL take that path only when the source fails, so an existing workflow behaves exactly as it did before the option existed

#### Scenario: A revision step returns on completion
- **WHEN** a loop-back declares that it is taken on success and its source completes
- **THEN** the system SHALL reset and re-run the loop-back segment, carrying the source's recorded output as the reason for the retry

#### Scenario: A success-triggered path ignores a failed source
- **WHEN** a loop-back declares that it is taken on success and its source fails
- **THEN** the system SHALL NOT take that path, and the failure SHALL be treated as any other failed node

#### Scenario: The attempt bound is shared across triggers
- **WHEN** several loop-backs point at the same target with different triggers
- **THEN** the target's attempt bound SHALL be counted once across all of them, so a loop that never converges still terminates

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
The `init` command SHALL accept a named preset that scaffolds a workflow other than the default graph, so a project can start from a workflow shaped around an existing methodology rather than editing the default graph into one. Presets SHALL produce a workflow file that passes the same validation as any hand-written one, and the absence of a preset SHALL scaffold the default graph unchanged. A preset is a scaffolded file and nothing more — it composes existing node types with skills and adds no registry surface, which is why a new methodology is a new preset rather than a new set of node types.

Every preset that contains a Spec node SHALL gate it on the same terms as the default graph. A methodology changes which skills write the spec, not whether a human agrees to it.

#### Scenario: Init with no preset
- **WHEN** the user runs `flow-code init` without naming a preset
- **THEN** the system SHALL scaffold the default Discuss → Spec → Approval-Gate → Implement → Test → Validate → Review → Approval-Gate → Git-ops graph

#### Scenario: Init with the openspec preset
- **WHEN** the user runs `flow-code init` naming the openspec preset
- **THEN** the system SHALL scaffold an explore → propose → apply → gate → archive graph built from the Discuss, Spec, Implement, Approval-Gate, and Git-ops node types, with the corresponding openspec skills attached to each agent-driven node, and with the proposed spec gated before it is applied

#### Scenario: Init with the spec-kit preset
- **WHEN** the user runs `flow-code init` naming the spec-kit preset
- **THEN** the system SHALL scaffold a workflow built from the same node types, with the corresponding spec-kit skills attached, alongside the openspec preset as an equally supported starting point, and with its Spec node gated

#### Scenario: A preset with no Spec node
- **WHEN** a preset scaffolds a graph containing no Spec node
- **THEN** it SHALL NOT be required to contain a spec gate, and its shape SHALL otherwise be unchanged

#### Scenario: A preset's skills are not installed
- **WHEN** a preset attaches skills that do not resolve in any discovery root
- **THEN** `init` SHALL scaffold the file and SHALL warn which skills are missing and where they are expected, rather than writing a workflow that silently fails to load

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

### Requirement: A workflow file may declare multiple named graphs
The workflow file SHALL support declaring more than one named graph, each with its own nodes and edges, so a repo can carry several shapes of the same process — for example a short one and a heavily verified one — in one reviewable file. Run-wide `settings` SHALL be declared once and apply to whichever graph is selected. A file declaring a single unnamed graph SHALL remain valid and keep its current meaning.

#### Scenario: A single-graph file
- **WHEN** a workflow file declares nodes and edges at the top level with no named graphs
- **THEN** the system SHALL load it exactly as it does today, and `flow-code run` SHALL execute it without asking anything

#### Scenario: A file declaring named graphs
- **WHEN** a workflow file declares named graphs
- **THEN** each named graph SHALL be validated independently against every node, config, settings, and structural check, and the file SHALL be invalid if any one of them is

#### Scenario: A file declaring both forms
- **WHEN** a workflow file declares both top-level nodes and named graphs
- **THEN** the system SHALL reject it rather than resolving the ambiguity by precedence

#### Scenario: A named graph declaring its own budget
- **WHEN** a named graph declares a `budget`
- **THEN** the system SHALL reject the file, naming the graph — a ceiling the shape may raise is not a ceiling, and a shape needing more work carries more nodes with their own per-node budgets

#### Scenario: A name that matches no graph
- **WHEN** a run is asked for a graph name the file does not declare
- **THEN** the system SHALL fail before starting execution, naming the requested graph and listing the names the file does declare

#### Scenario: Validation covers every declared graph
- **WHEN** the user runs `flow-code validate` on a file declaring named graphs
- **THEN** the report SHALL identify which graph each failure belongs to, so a failure in one shape is not mistaken for a failure in another

### Requirement: A run selects which declared graph it executes
When the workflow file declares more than one named graph, `flow-code run` SHALL establish which one this run executes before any node starts, and SHALL make the selected name visible for the duration of the run. The selection SHALL be answerable interactively, and SHALL also be specifiable without a prompt so a non-interactive run is not blocked on one.

#### Scenario: Interactive selection
- **WHEN** the user runs `flow-code run` in a terminal against a file declaring named graphs and does not name one
- **THEN** the system SHALL ask which to run, offering every declared name with its description, and SHALL start no node until the question is answered

#### Scenario: Selection given up front
- **WHEN** a run is started naming a declared graph
- **THEN** the system SHALL execute that graph without asking, and the run SHALL record which name it selected

#### Scenario: No terminal to ask in
- **WHEN** a run is started without a terminal against a file declaring named graphs and no name is given
- **THEN** the system SHALL fail before starting execution rather than choosing a graph on the user's behalf

#### Scenario: The selected name is visible during the run
- **WHEN** a run is executing a named graph
- **THEN** the name SHALL be reported on screen, so which shape is running is legible without comparing the graph to the file

