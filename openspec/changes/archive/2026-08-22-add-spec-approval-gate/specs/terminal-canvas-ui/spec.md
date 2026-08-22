## ADDED Requirements

### Requirement: Structured node output is rendered as prose

A node whose entire session reply is a JSON object — Spec, Validate, Review, and a discussion's closing turn — SHALL have its parsed output presented in the detail view as styled prose, using the same markdown rendering the Discuss transcript and the approval gate use, rather than as plain unstyled lines or as the raw JSON it arrived in. Where the same output is also shown at an Approval-Gate, the two views SHALL agree: a reader SHALL NOT have to reconcile two renderings of one artifact.

#### Scenario: A finished Spec node is expanded
- **WHEN** the user expands a Spec node that has completed
- **THEN** the detail view SHALL show its title, the path it wrote, its requirements and its acceptance criteria with markdown styling applied — criterion ids emphasized, list items as list items — and SHALL NOT display the markdown markers themselves

#### Scenario: The same spec seen at the gate and in the node
- **WHEN** a spec is shown both as a document at an Approval-Gate and in the Spec node's detail view
- **THEN** the two SHALL render the same content through the same path, so approving at the gate and reading at the node cannot disagree about what the spec says

#### Scenario: Output that has not parsed yet
- **WHEN** a node's reply is still streaming, or its output did not parse into the shape its type expects
- **THEN** the detail view SHALL fall back to the raw transcript rather than a blank or half-populated block, as it does today
