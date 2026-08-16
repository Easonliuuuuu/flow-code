## ADDED Requirements

### Requirement: Every git-writing node is gated
The system SHALL validate, before execution, that every node whose type holds the `git-write` capability is dominated by an Approval-Gate node over the forward-edge subgraph — that is, every path from every root of the graph to that node passes through an Approval-Gate. A graph that does not satisfy this SHALL fail to load. The check SHALL key on the `git-write` capability rather than on any node type id, so a type granted that capability in future is covered without the check being updated. A forward edge carrying a `when:` condition SHALL count as present for this analysis, because a path that may carry is a path that may commit. Loop-back edges are excluded, as they are from every other structural check.

This closes the gap left by the derived approval condition, which constrains only the edges leaving a gate and therefore says nothing about a git-writing node that no gate precedes.

#### Scenario: A git-writing node with no gate anywhere upstream
- **WHEN** a workflow file declares a Git-ops node whose forward-edge ancestors contain no Approval-Gate
- **THEN** the system SHALL fail before starting execution with an error naming the node and stating that a git-writing node requires an Approval-Gate upstream of it

#### Scenario: A gate on one path but not another
- **WHEN** a workflow file declares a Git-ops node reachable both through an Approval-Gate and by a second forward path that bypasses it
- **THEN** the system SHALL fail before starting execution, naming the node and the path that reaches it without passing a gate, because a gate that can be routed around is not a gate

#### Scenario: A conditional edge bypassing the gate
- **WHEN** the only path that bypasses an Approval-Gate to reach a git-writing node carries a `when:` condition
- **THEN** the system SHALL still fail, because the condition may hold and the node would then commit without approval

#### Scenario: A gate dominating the git-writing node
- **WHEN** every forward path from every root to a Git-ops node passes through an Approval-Gate
- **THEN** the system SHALL accept the graph

#### Scenario: Independent branches with their own gates
- **WHEN** a workflow file declares two independent branches, each ending in a git-writing node preceded by its own Approval-Gate
- **THEN** the system SHALL accept the graph, because each git-writing node is dominated by a gate on every path that reaches it

#### Scenario: A graph with no git-writing node
- **WHEN** a workflow file declares no node holding the `git-write` capability
- **THEN** the check SHALL find nothing to enforce and SHALL NOT require the graph to contain an Approval-Gate

#### Scenario: Reported alongside the other structural failures
- **WHEN** a workflow file fails this check and also declares a loop-back that does not point at an ancestor
- **THEN** validation SHALL report both, because neither check depends on the other having passed

#### Scenario: The default scaffold and shipped presets satisfy it
- **WHEN** the workflow scaffolded by `flow-code init`, with or without a named preset, is loaded
- **THEN** it SHALL satisfy this check without modification

### Requirement: A graph declares at most one Plan node, at its root
The system SHALL validate, before execution, that a graph contains no more than one node of type `plan`, and that such a node has no forward-edge ancestors. A graph violating either SHALL fail to load. This bounds what expansion has to mean: there is exactly one point at which a graph grows, and nothing has run before it.

#### Scenario: More than one Plan node
- **WHEN** a workflow file declares two Plan nodes
- **THEN** the system SHALL fail before starting execution, naming both and stating that a graph may declare at most one

#### Scenario: A Plan node with an upstream dependency
- **WHEN** a workflow file declares a Plan node with a forward edge pointing into it
- **THEN** the system SHALL fail before starting execution, naming the node and stating that a Plan node must be a root

#### Scenario: A single Plan node at the root
- **WHEN** a workflow file declares one Plan node with no forward-edge ancestors
- **THEN** the system SHALL accept the graph

#### Scenario: No Plan node
- **WHEN** a workflow file declares no Plan node
- **THEN** these checks SHALL find nothing to enforce

## MODIFIED Requirements

### Requirement: Built-in node type registry
The system SHALL expose a registry of built-in node types (Discuss, Plan, Implement, Test, Validate, Review, Git-ops, Worktree-Agent, Approval-Gate). Each type SHALL be defined by a capability set, a default role prompt, an output schema, and whether the type is interactive, in addition to its config schema. A type MAY additionally declare that it is context-transparent and MAY declare a failure predicate over its own output.

#### Scenario: Listing available node types
- **WHEN** the user runs `flow-code node-types`
- **THEN** the system prints every built-in node type's id, its capability set, whether it is agent-driven and whether it is interactive, a short description of its config schema, and the shape of its output

#### Scenario: Every type declares a capability set
- **WHEN** a node type is registered
- **THEN** it SHALL declare the capabilities its execution is permitted to use, drawn from `read`, `edit`, `exec`, `git-read`, and `git-write`

### Requirement: Workflow presets
The `init` command SHALL accept a named preset that scaffolds a workflow other than the default graph, so a project can start from a workflow shaped around an existing methodology rather than editing the default graph into one. Presets SHALL produce a workflow file that passes the same validation as any hand-written one, and the absence of a preset SHALL scaffold the default graph unchanged. A preset is a scaffolded file and nothing more — it composes existing node types with skills and adds no registry surface, which is why a new methodology is a new preset rather than a new set of node types. Scaffolding a preset SHALL start no agent session and spend no tokens.

#### Scenario: Init with no preset
- **WHEN** the user runs `flow-code init` without naming a preset
- **THEN** the system SHALL scaffold the default Discuss → Spec → Implement → Test → Validate → Review → Approval-Gate → Git-ops graph

#### Scenario: Init with the openspec preset
- **WHEN** the user runs `flow-code init` naming the openspec preset
- **THEN** the system SHALL scaffold an explore → propose → apply → gate → archive graph built from the Discuss, Spec, Implement, Approval-Gate, and Git-ops node types, with the corresponding openspec skills attached to each agent-driven node

#### Scenario: Init with the spec-kit preset
- **WHEN** the user runs `flow-code init` naming the spec-kit preset
- **THEN** the system SHALL scaffold a workflow built from the same node types, with the corresponding spec-kit skills attached, alongside the openspec preset as an equally supported starting point

#### Scenario: Init with the planned preset
- **WHEN** the user runs `flow-code init` naming the planned preset
- **THEN** the system SHALL scaffold a `plan` → Approval-Gate → Git-ops spine and nothing else, so the graph between them is negotiated at run time by the Plan node

#### Scenario: A preset's skills are not installed
- **WHEN** a preset attaches skills that do not resolve in any discovery root
- **THEN** `init` SHALL scaffold the file and SHALL warn which skills are missing and where they are expected, rather than writing a workflow that silently fails to load

#### Scenario: A preset's CLI dependency is missing
- **WHEN** a preset declares an external CLI it depends on and that CLI is not found on `PATH`
- **THEN** `init` SHALL offer, interactively, to install it before scaffolding, and SHALL proceed to scaffold either way — declining or a failed install SHALL NOT block the preset from being written

#### Scenario: A preset can scaffold its own missing skills
- **WHEN** a preset declares a command that scaffolds its required skills (e.g. `openspec init`) and those skills are not yet installed
- **THEN** `init` SHALL offer to run that command against the repo root, as an alternative to only warning that the skills are missing

#### Scenario: An unknown preset name
- **WHEN** the user names a preset that does not exist
- **THEN** the system SHALL fail with an error listing the available preset names and SHALL NOT create or modify a workflow file
