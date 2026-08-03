## ADDED Requirements

### Requirement: Skill text is composed behind the capability boundary
When a node has resolved skills attached, the system SHALL compose their text into the session's system prompt ahead of the node type's role prompt and ahead of the capability boundary statement, so the boundary is stated last and the skill cannot present itself as overriding it. The compiled tool policy SHALL be derived from the node type's capability set alone and SHALL be unaffected by attached skills.

#### Scenario: A node with skills starts a session
- **WHEN** the system builds a session request for a node with attached skills
- **THEN** the system prompt SHALL contain the composed skill text, then the node type's role prompt, then the capability boundary statement

#### Scenario: The tool policy is independent of skills
- **WHEN** the tool policy is compiled for a node with attached skills
- **THEN** the resulting allowed and denied tool sets SHALL be identical to those compiled for the same node type with no skills attached

#### Scenario: Skill composition is runner-independent
- **WHEN** a session request carrying composed skill text is executed
- **THEN** every `SessionRunner` implementation SHALL deliver that text to its provider through the same field it uses for the role prompt, with no runner-specific skill handling

### Requirement: A node's skills are visible during and after the run
The system SHALL record which skills a node ran with, and SHALL surface them in that node's detail view alongside its output and activity log, so an observer can attribute the node's behavior to the instructions it was given.

#### Scenario: Inspecting a node that carried skills
- **WHEN** the user opens the detail view of a node with attached skills
- **THEN** the system SHALL show the identifiers of the skills that node ran with

#### Scenario: A skill's instructions are denied a tool
- **WHEN** a tool call originating from a skill's instructions is denied by the harness
- **THEN** the denial SHALL be recorded in the node's activity log with the same shape as any other denied call

### Requirement: Unmet output contracts distinguish their cause
When an agent-driven node's session terminates without producing output conforming to its type's output schema, the system SHALL classify the failure and report the cause in the node's status detail, distinguishing at least a session that ended by requesting user input from output that was produced but did not conform to the schema.

#### Scenario: The session ended by asking a question
- **WHEN** a non-interactive node's session produces no conforming output and its final response requests input from the user
- **THEN** the node SHALL reach `error` with a status detail stating that the session ended by asking a question and that the node is non-interactive

#### Scenario: The session produced malformed output
- **WHEN** a node's session produces a response that is not valid output for its type's schema and is not a request for user input
- **THEN** the node SHALL reach `error` with a status detail identifying the schema violation

#### Scenario: The full response is retained either way
- **WHEN** a node fails for either cause
- **THEN** the session's final response SHALL be retained in the node's recorded output or streamed output, so the user can read what the session actually said
