## MODIFIED Requirements

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

#### Scenario: Default graph stops on a rejected gate
- **WHEN** the scaffolded default workflow is loaded
- **THEN** the Approval-Gate node SHALL have no loop-back edge and no rejection branch, so a rejection ends the run by default; the file SHALL document, without enabling, how to route a rejection to a revision step instead

#### Scenario: Init in a repo that already has a workflow file
- **WHEN** the user runs `flow-code init` in a repo that already has `.flow-code/workflow.yaml`
- **THEN** the system SHALL NOT overwrite the existing file and SHALL inform the user it already exists

## ADDED Requirements

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
