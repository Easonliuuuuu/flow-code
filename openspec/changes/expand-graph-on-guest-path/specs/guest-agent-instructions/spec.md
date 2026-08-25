## ADDED Requirements

### Requirement: Instructions describe expansion for a graph that can grow
When the project's workflow contains a Plan node, the generated instructions SHALL describe what completing it does: the run's graph grows, and the nodes to report next come from the run rather than from the instructions. Without this the brief lists the graph as it stands before planning, which is every node except the ones the guest is about to be asked to walk.

#### Scenario: The workflow contains a Plan node
- **WHEN** instructions are generated for a workflow containing a Plan node
- **THEN** that node's section SHALL state that its output is a proposed set of nodes and edges, that reporting it complete replaces its successors with that proposal, and that the run — not the brief — is the authority on what may be reported afterwards

#### Scenario: The workflow contains no Plan node
- **WHEN** instructions are generated for a workflow with no Plan node
- **THEN** the instructions SHALL NOT mention expansion, so a brief for a fixed graph is not padded with a step that cannot occur
