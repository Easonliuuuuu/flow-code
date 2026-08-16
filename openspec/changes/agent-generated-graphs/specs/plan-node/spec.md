## ADDED Requirements

### Requirement: Plan is an interactive node type
The system SHALL provide a built-in `plan` node type that is interactive and holds the `read` capability only. It SHALL be placed on the graph like any other node, with its own node id, status, detail view, focus target, and recorded execution state. Its purpose is to settle, in conversation with the user, both what is being built and the graph that builds it.

#### Scenario: Plan node appears on the graph
- **WHEN** a workflow file declares a Plan node
- **THEN** the system SHALL render it as a node box, allow it to be focused and expanded like any other node, and track its status in the run-state store

#### Scenario: Plan cannot modify the repository
- **WHEN** a Plan node's session attempts to edit or create a file, or to run a command
- **THEN** the attempt SHALL be denied by its compiled capability set, as it is for any other node without that capability

#### Scenario: Plan is listed as a node type
- **WHEN** the user runs `flow-code node-types`
- **THEN** the Plan type SHALL be listed with its capability set, that it is agent-driven and interactive, its config schema, and its output shape

### Requirement: The Plan node completes only on user acceptance
A Plan node SHALL hold status `running` while the graph is being negotiated and SHALL NOT complete until the user accepts a proposed graph. The user SHALL be able to reject or amend a proposal and receive a revised one within the same session. Acceptance SHALL be what completes the node; there SHALL be no separate approval step for the graph.

#### Scenario: Agent proposes and the user accepts
- **WHEN** the agent proposes a graph and the user accepts it
- **THEN** the Plan node SHALL complete with that graph as its output

#### Scenario: User amends a proposal
- **WHEN** the user responds to a proposal by asking for a different shape
- **THEN** the session SHALL continue and the agent SHALL propose a revised graph, without the node completing on the superseded proposal

#### Scenario: No graph is ever accepted
- **WHEN** the user ends the Plan node's session without accepting any proposal
- **THEN** the node SHALL end in `error`, every node downstream SHALL be `skipped`, and no work SHALL have been done to the repository

#### Scenario: Plan is interrupted
- **WHEN** a run is interrupted while a Plan node is negotiating
- **THEN** the run SHALL be resumable, and the resumed run SHALL NOT treat an unaccepted proposal as accepted

### Requirement: A proposed graph uses only registered node types
A graph proposed by a Plan node SHALL be expressible entirely in the existing workflow format using only node types in the built-in registry. Planning SHALL introduce no node type, no capability, and no configuration the existing schema does not accept. Within that vocabulary the planner SHALL be free to choose the number of nodes and their ids, each node's config and `instructions`, fan-out across parallel branches or Worktree-Agent instances, which loop-back edges exist and their attempt bounds, and each node's `model` and `budget`.

#### Scenario: Proposal uses only registered types
- **WHEN** a Plan node proposes a graph
- **THEN** every proposed node's `type` SHALL resolve in the built-in registry

#### Scenario: Shape varies with the task
- **WHEN** the negotiated task is a small localized change, and separately when it spans many files
- **THEN** the planner SHALL be permitted to propose graphs differing in node count, fan-out, and loop-back bounds, rather than being constrained to one shape

#### Scenario: A proposal may include further discussion
- **WHEN** the negotiated task warrants more conversation once the shape is settled
- **THEN** the planner SHALL be permitted to place a Discuss node in the graph it proposes, as an ordinary use of its vocabulary

#### Scenario: A proposal cannot widen what a node may do
- **WHEN** a proposed node carries instructions describing work its type's capabilities do not permit
- **THEN** the node SHALL still run under its type's capability set unchanged — planning determines graph shape and configuration, never what a session is allowed to do

### Requirement: A proposed graph is validated before it is spliced
The system SHALL build the graph resulting from a proposal through the same checks a workflow file passes — node types, node config schemas, the settings block, and every structural check including the git-writing-node gate invariant — before any of it executes. A proposal that fails SHALL NOT be spliced, and its failures SHALL be returned to the same session, which SHALL revise and repropose.

#### Scenario: A valid proposal
- **WHEN** an accepted proposal passes every check
- **THEN** the system SHALL splice it into the graph and continue execution

#### Scenario: An invalid proposal
- **WHEN** an accepted proposal fails one or more checks
- **THEN** the system SHALL NOT splice it, and SHALL return every reported failure to the session rather than only the first

#### Scenario: A proposal that routes around the gate
- **WHEN** a proposal produces a graph in which a git-writing node is not dominated by an Approval-Gate
- **THEN** it SHALL be rejected by the same structural check that rejects a hand-written graph of that shape, and SHALL be reproposed rather than spliced

#### Scenario: Rejection is visible in the conversation
- **WHEN** a proposal is rejected by validation
- **THEN** the reason SHALL be visible to the user in the Plan node's session, rather than the retry being hidden

### Requirement: An accepted graph is spliced between the Plan node and its successors
On acceptance, the proposed nodes and edges SHALL be inserted between the Plan node and the nodes its outgoing forward edges point at, producing one graph that is validated and executed as a whole. The Plan node's own recorded state SHALL be carried forward unchanged, and every node downstream SHALL run as an ordinary node of that graph.

#### Scenario: Spine expands into the full graph
- **WHEN** a Plan node in a `plan → approval-gate → git-ops` spine completes with an accepted proposal
- **THEN** the resulting graph SHALL contain the proposed nodes between the Plan node and the Approval-Gate, and execution SHALL continue into them

#### Scenario: Plan node state survives expansion
- **WHEN** a graph is expanded
- **THEN** the Plan node SHALL remain `done` with its output intact, and SHALL NOT be re-executed

#### Scenario: Expanded nodes are ordinary nodes
- **WHEN** a node from an accepted proposal executes
- **THEN** it SHALL be subject to its type's capabilities, its budget, loop-back handling, and mid-run edits exactly as a node declared in a workflow file is

### Requirement: A planned graph can be kept as a static workflow
After a run that expanded a graph, the system SHALL offer to write the expanded graph to `.flow-code/workflow.yaml`, replacing the spine. The offer SHALL be made interactively at the point the user can judge the shape, and SHALL NOT require a flag known in advance. A kept graph SHALL contain no Plan node, so a subsequent run executes it directly with no planning.

#### Scenario: Keeping the graph
- **WHEN** the user accepts the offer to keep an expanded graph
- **THEN** the system SHALL write it to `.flow-code/workflow.yaml` as a valid workflow file containing no Plan node

#### Scenario: Declining the offer
- **WHEN** the user declines
- **THEN** `.flow-code/workflow.yaml` SHALL be left unchanged, and the next run SHALL plan again

#### Scenario: A kept graph runs without planning
- **WHEN** `flow-code run` is invoked against a kept graph
- **THEN** it SHALL execute directly, with no Plan node, no planning session, and no token spent on planning
