## MODIFIED Requirements

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
