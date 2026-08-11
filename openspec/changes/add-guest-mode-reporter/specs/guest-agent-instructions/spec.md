## ADDED Requirements

### Requirement: Instructions are generated from the project's workflow
The system SHALL generate agent-facing instructions from `.flow-code/workflow.yaml` that describe the graph a host agent is expected to walk: the nodes in order, what each node is for, what each node must produce, and how to report each transition. The instructions SHALL be derived from the workflow file rather than hand-maintained, so a project's instructions always describe that project's actual graph.

#### Scenario: Instructions describe the project's own nodes
- **WHEN** instructions are generated for a workflow whose nodes are `discuss → implement → test`
- **THEN** the generated instructions SHALL name those three nodes in that order, and SHALL NOT describe nodes the workflow does not contain

#### Scenario: A node's output contract reaches the agent
- **WHEN** instructions are generated for a node type that declares an output shape
- **THEN** the instructions SHALL state what that node must report on completion, in enough detail that a compliant agent produces output passing the node type's validation

#### Scenario: Loop-back edges are explained
- **WHEN** the workflow declares a loop-back edge from `test` to `implement`
- **THEN** the instructions SHALL tell the agent what to do when the failing condition occurs, since no engine will route it back automatically

### Requirement: Instructions are installed where the host agent reads them
The system SHALL install the generated instructions into the locations a host agent actually reads, and SHALL report which locations it wrote. Installation SHALL be idempotent, and SHALL NOT overwrite unrelated content in a shared file.

#### Scenario: Installing alongside existing agent instructions
- **WHEN** instructions are installed into a project whose agent instruction file already contains unrelated content
- **THEN** the system SHALL add or replace only its own delimited section and SHALL leave the rest of the file byte-identical

#### Scenario: Re-installing after no change
- **WHEN** installation is run twice with no workflow change in between
- **THEN** the second run SHALL leave every written file unchanged

### Requirement: One installation delivers every surface the host supports
For a host that supports packaged extensions, the system SHALL deliver its instructions, its reporting tools, and its enforcement layer as a single installable unit, so a user cannot end up with some of them active and the rest merely intended. Where a host supports only some of those surfaces, the installation SHALL report which were installed and which the host does not support.

#### Scenario: Installing on a host with packaged extensions
- **WHEN** the user installs flow-code's extension into a host that supports packaged extensions
- **THEN** the instructions, the reporting tools, and the enforcement layer SHALL all become active without a further manual registration step

#### Scenario: A host that supports only part of the surface
- **WHEN** the extension is installed into a host that cannot run flow-code's enforcement layer
- **THEN** the system SHALL install the surfaces the host does support, SHALL report which were not installed, and SHALL state that runs from that host carry no capability enforcement

#### Scenario: The installation does not silently edit unrelated configuration
- **WHEN** the extension is installed
- **THEN** it SHALL NOT modify the user's existing agent configuration beyond its own delimited or self-owned entries, and SHALL name every file it changed

### Requirement: Stale instructions are detected
The system SHALL detect when installed instructions no longer match the current `.flow-code/workflow.yaml` and SHALL report the mismatch. A host agent walking a graph that no longer exists is a source of silently wrong runs, so the disagreement SHALL be surfaced rather than tolerated.

#### Scenario: The workflow changed after instructions were installed
- **WHEN** a node is added to `.flow-code/workflow.yaml` after instructions were installed
- **THEN** the system SHALL report the installed instructions as stale and SHALL name the difference

#### Scenario: Instructions have never been installed
- **WHEN** a guest run is opened in a project where instructions were never installed
- **THEN** the system SHALL report that the host agent has no instructions for this workflow, rather than failing silently
