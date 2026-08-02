## ADDED Requirements

### Requirement: Per-node model override
Each agent-driven node SHALL run on the model named in its own `config.model` when present, falling back to the run-wide `settings.model`, and falling back to the provider's default model when neither is set.

#### Scenario: Node with its own model
- **WHEN** a node declares `config.model` and the workflow also declares `settings.model`
- **THEN** that node's agent session SHALL use the node's model and every other node SHALL use `settings.model`

#### Scenario: Node without its own model
- **WHEN** a node declares no `config.model`
- **THEN** its agent session SHALL use `settings.model`, or the configured provider's default model when `settings.model` is absent

### Requirement: Model picker on the focused node
The system SHALL provide a model picker for the focused node, reachable by keyboard alone, listing the models available for the project's configured provider and marking which one the node currently resolves to.

#### Scenario: Opening the picker by keyboard
- **WHEN** the user presses the model-picker key on a focused agent-driven node
- **THEN** the system SHALL open a picker listing the configured provider's models, with the node's currently resolved model marked as selected

#### Scenario: Node type has no model
- **WHEN** the user opens the picker on a node type that runs no agent session, such as Test or Approval-Gate
- **THEN** the system SHALL decline with a brief message naming the node type, and SHALL NOT open an empty picker

#### Scenario: Dismissing without choosing
- **WHEN** the user closes the picker without confirming a selection
- **THEN** the node's model SHALL be unchanged and the workflow file SHALL NOT be written

#### Scenario: Provider is not configured
- **WHEN** the user opens the picker in a run whose provider could not be resolved from credentials or environment
- **THEN** the system SHALL decline with a message pointing at `flow-code init`, and SHALL NOT open the picker

### Requirement: Model choice is persisted to the workflow file
A confirmed model selection SHALL be written back to `.flow-code/workflow.yaml` as that node's `config.model`, leaving every comment, key order, and unrelated formatting in the file intact.

#### Scenario: Comments and unrelated content survive the edit
- **WHEN** the user confirms a model for a node in a workflow file containing comments, blank lines, and other nodes
- **THEN** the file SHALL differ only in that node's `config.model` value, with every comment, blank line, key order, and other node preserved byte-for-byte

#### Scenario: Node has no config block yet
- **WHEN** the user confirms a model for a node whose entry declares no `config` mapping
- **THEN** the system SHALL create the `config` mapping with `model` set, and the resulting file SHALL still parse and validate as a workflow

#### Scenario: Selecting the run-wide default
- **WHEN** the user selects the model that `settings.model` already names
- **THEN** the system SHALL remove that node's `config.model` rather than writing a redundant override, and the node SHALL resolve to `settings.model`

#### Scenario: Workflow file cannot be written
- **WHEN** writing `.flow-code/workflow.yaml` fails, for example on a read-only filesystem
- **THEN** the system SHALL report the failure in the UI, SHALL leave the file unmodified, and the run SHALL continue uninterrupted

### Requirement: Model change takes effect by node status
A model change SHALL apply to the current run for any node that has not yet started, and SHALL NOT retroactively affect a node whose agent session has already begun.

#### Scenario: Changing a pending node
- **WHEN** the user confirms a new model for a node that has not started
- **THEN** that node SHALL use the new model when the run reaches it, without restarting the run

#### Scenario: Changing a running or completed node
- **WHEN** the user opens the picker on a node whose status is `running` or `done`
- **THEN** the system SHALL show the node's model together with a statement that a change applies on re-run, and SHALL NOT alter the session already in flight

#### Scenario: Re-run after a change
- **WHEN** a node whose model was changed while it was `done` is re-run through a loop-back edge
- **THEN** the re-run SHALL use the newly selected model

### Requirement: Overridden model is visible on the graph
A node whose effective model differs from the run-wide default SHALL carry a visible indicator on its box, so an override is discoverable without expanding the node.

#### Scenario: Node with an override
- **WHEN** a node's resolved model differs from `settings.model`
- **THEN** its node box SHALL display a model badge naming that model, truncated to fit the box

#### Scenario: Node on the default model
- **WHEN** a node's resolved model is the run-wide default
- **THEN** its node box SHALL carry no model badge

#### Scenario: Detail view names the model
- **WHEN** the user expands any agent-driven node
- **THEN** its detail view SHALL name the model that node resolves to and whether that came from the node, the run settings, or the provider default
