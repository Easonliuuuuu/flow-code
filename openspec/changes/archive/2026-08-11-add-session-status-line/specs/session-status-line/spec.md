## ADDED Requirements

### Requirement: A live run summarizes to a bounded text status
The system SHALL render the current run of a repository as a text status bounded to a caller-supplied width, naming the node that most needs attention, how much of the graph is complete, and what the run has spent. The summary SHALL be produced by a process other than the one driving the run.

#### Scenario: A run with a node awaiting input
- **WHEN** a status is rendered for a run in which a node is `waiting`
- **THEN** the summary SHALL name that node and what it is waiting for, in preference to any node that is merely running

#### Scenario: A run with work in progress
- **WHEN** a status is rendered for a run with no waiting node and at least one running node
- **THEN** the summary SHALL name a running node, how long it has been running, and — when it is past its first attempt — which attempt it is on

#### Scenario: A finished run
- **WHEN** a status is rendered for a run that completed
- **THEN** the summary SHALL report it as finished rather than naming a node, and SHALL distinguish a run that completed from one that was interrupted

#### Scenario: No run exists
- **WHEN** a status is rendered in a repository with no recorded run
- **THEN** the system SHALL render an idle summary and SHALL NOT report an error

### Requirement: The status degrades with width without losing what blocks the run
The system SHALL fit its output to the width it is given, measured in display columns, and SHALL drop content in a fixed order that preserves the blocking node's identity and reason to the last.

#### Scenario: Ample width
- **WHEN** a status is rendered at a width that fits every element
- **THEN** it SHALL include per-node labels alongside their statuses

#### Scenario: Constrained width
- **WHEN** the available width cannot fit per-node labels
- **THEN** the system SHALL reduce the per-node display to status indicators and SHALL retain the blocking node's name and reason

#### Scenario: Severely constrained width
- **WHEN** the available width cannot fit the reduced form either
- **THEN** the system SHALL render the blocking node's name and reason alone, and SHALL NOT wrap to an additional row

#### Scenario: Wide characters
- **WHEN** node ids or status details contain characters wider than one column
- **THEN** the rendered status SHALL still fit the given width

### Requirement: Reading a run never disturbs it
The system SHALL treat the run document as read-only when rendering a status: it SHALL NOT write, lock, or otherwise alter the run, and SHALL NOT prevent or delay the driving process.

#### Scenario: Rendering against a live run
- **WHEN** a status is rendered repeatedly while a run is being driven
- **THEN** the run's document SHALL be unaffected and the driving process SHALL be unimpeded

#### Scenario: The document is mid-write or unreadable
- **WHEN** a status is rendered while the run document is incomplete, unreadable, or in an unrecognized shape
- **THEN** the system SHALL render the idle summary rather than failing, and SHALL NOT report a partial read as run state

### Requirement: A run whose driver has died is reported as such
The system SHALL distinguish a run still being driven from one whose driving process is gone, and SHALL NOT present the latter as work in progress.

#### Scenario: The driver died mid-node
- **WHEN** a status is rendered for an unfinished run whose recorded driving process is no longer alive
- **THEN** the summary SHALL report the run as no longer being driven, rather than naming its last node as running

### Requirement: Guarantees the run did not carry are not implied
The system SHALL render figures a run's enforcement tier does not provide as unavailable rather than as zero, and SHALL identify the tier when it is not flow-code's own engine.

#### Scenario: A run with no token accounting
- **WHEN** a status is rendered for a run whose recorded tier provides no token accounting
- **THEN** spend SHALL be rendered as unavailable, and SHALL NOT be rendered as zero

#### Scenario: A run driven by something other than the engine
- **WHEN** a status is rendered for a run that flow-code's engine did not execute
- **THEN** the summary SHALL identify that, so the status is not read as carrying engine-driven guarantees

### Requirement: The status composes into a status surface the user already owns
The system SHALL be able to emit its summary as a fragment suitable for embedding in an existing status surface, in addition to any complete status output it offers. Embedding SHALL NOT require the user to surrender a status surface they have already configured.

#### Scenario: Embedding beside existing content
- **WHEN** the summary is emitted for embedding
- **THEN** it SHALL contain only the summary itself, with no leading or trailing content that assumes ownership of the surrounding line

#### Scenario: A user with no status surface
- **WHEN** a user has no existing status surface
- **THEN** the system SHALL be able to provide a complete one without requiring the user to author it
