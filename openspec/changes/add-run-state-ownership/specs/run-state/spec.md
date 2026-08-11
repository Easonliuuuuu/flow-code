## MODIFIED Requirements

### Requirement: One writer owns a run document
Exactly one process SHALL write a given run document — the process driving that run. Ownership SHALL be recorded in the document and verified by the writer before each write, so that a second writer is refused rather than merely absent. Every other reader of the document SHALL be read-only, and SHALL be able to determine whether the writing process is still alive.

#### Scenario: A second reader attaches to a live run
- **WHEN** a reader opens a run document that another process is driving
- **THEN** the reader SHALL reflect updates as they are written and SHALL NOT write to the document

#### Scenario: The writing process dies
- **WHEN** the process driving a run exits without the run finishing
- **THEN** a reader SHALL report that the run is no longer being driven rather than presenting the last written state as live

#### Scenario: A second writer attempts to write a run it does not own
- **WHEN** a process attempts to write a run document whose recorded owner is not that process
- **THEN** the write SHALL be refused, the document SHALL be left byte-identical, and the refusal SHALL name the run and the fact that it is owned elsewhere

#### Scenario: Ownership is checked against the document, not assumed from startup
- **WHEN** a process that owned a run document writes to it after another process has replaced its ownership
- **THEN** the write SHALL be refused rather than overwriting the new owner's state

#### Scenario: A refused write is reported, never dropped
- **WHEN** a writer's ownership check fails during a run
- **THEN** the system SHALL surface the failure and SHALL NOT continue as though the run's state were still being recorded

## ADDED Requirements

### Requirement: Ownership transfers explicitly
A process resuming a run SHALL take ownership of that run's document as a recorded act, and SHALL be refused when the run's current owner is still alive. Continuing a run under its original id SHALL NOT silently overwrite another process's ownership.

#### Scenario: Resuming a run whose owner is gone
- **WHEN** a run is resumed while its recorded owner is no longer alive
- **THEN** the resuming process SHALL become the recorded owner, and its subsequent writes SHALL be accepted

#### Scenario: Resuming a run that is still being driven
- **WHEN** a run is resumed while its recorded owner is still alive
- **THEN** the system SHALL refuse to take ownership and SHALL report that the run is already being driven

#### Scenario: The previous owner is preserved, not erased
- **WHEN** ownership of a run transfers
- **THEN** the document SHALL record that a transfer occurred, so a reader can tell a resumed run from one driven by a single process throughout

### Requirement: Liveness distinguishes unknowable from dead
The system SHALL report a run's driver as alive, not alive, or of unknowable status, and SHALL NOT collapse the unknowable case into either of the others. Liveness SHALL be unknowable when the document was written by a machine other than the one reading it, and when the document records no owner identity to check.

#### Scenario: A run written on another machine
- **WHEN** a reader opens a run document recorded as owned by a different machine
- **THEN** the system SHALL report the driver's status as unknowable, and SHALL NOT report the run as either live or abandoned

#### Scenario: A run document written before ownership was recorded
- **WHEN** a reader opens a run document that carries no owner identity
- **THEN** the system SHALL report the driver's status as unknowable rather than inferring it

#### Scenario: Unknowable status never authorizes reclamation
- **WHEN** an operation would reclaim or delete resources belonging to a run — worktrees, branches, or any other artifact — and that run's driver status is unknowable
- **THEN** the system SHALL NOT treat the run as abandoned for the purpose of that reclamation

### Requirement: A run that died badly is described as such
A reader SHALL be able to distinguish a run that finished, a run that was interrupted cleanly, a run still being driven, and a run whose driver disappeared without finishing it.

#### Scenario: The driver was killed without running its shutdown path
- **WHEN** a reader opens an unfinished run document whose owner is not alive
- **THEN** the system SHALL describe the run as having stopped without finishing, distinctly from a run that was interrupted cleanly

#### Scenario: A cleanly interrupted run
- **WHEN** a reader opens a run that recorded a clean interruption
- **THEN** the system SHALL describe it as interrupted, and it SHALL remain resumable

### Requirement: A reader with no run id gets a defined answer
A reader that attaches without naming a run SHALL attach to the single live run when exactly one exists, and SHALL report the ambiguity when several runs are live rather than choosing between them silently.

#### Scenario: Exactly one live run
- **WHEN** a reader attaches without naming a run and one run is live
- **THEN** it SHALL attach to that run

#### Scenario: Several runs are live at once
- **WHEN** a reader attaches without naming a run and more than one run is live
- **THEN** the system SHALL make the ambiguity visible rather than presenting one of them as the run, and a reader with room to do so SHALL identify the candidates

#### Scenario: No live run
- **WHEN** a reader attaches without naming a run and no run is live
- **THEN** the system SHALL attach to the most recent run and SHALL NOT present it as being driven

### Requirement: A crash mid-write leaves the previous document intact
Writing a run document SHALL replace it atomically. A process that dies partway through a write SHALL leave the previously written document readable, and SHALL NOT leave a partially written document in its place.

#### Scenario: The writer dies during a write
- **WHEN** the writing process is killed while a run document is being written
- **THEN** the run document at its published path SHALL still parse, and SHALL contain the state as of the last completed write

#### Scenario: No partial document is ever published
- **WHEN** a run document is written
- **THEN** at no point SHALL a reader observe the document at its published path in a partially written state
