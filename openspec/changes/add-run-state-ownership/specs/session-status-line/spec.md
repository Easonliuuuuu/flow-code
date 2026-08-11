## MODIFIED Requirements

### Requirement: A run whose driver has died is reported as such
The system SHALL distinguish a run still being driven from one whose driving process is gone, and SHALL NOT present the latter as work in progress. Where the driver's status cannot be determined, the status SHALL say neither — it SHALL NOT claim the run is still moving, and it SHALL NOT claim the driver is gone.

#### Scenario: The driver died mid-node
- **WHEN** a status is rendered for an unfinished run whose recorded driving process is no longer alive
- **THEN** the summary SHALL report the run as no longer being driven, rather than naming its last node as running

#### Scenario: The driver's status cannot be determined
- **WHEN** a status is rendered for an unfinished run whose driver status is unknowable — the run was written by another machine, or records no owner identity
- **THEN** the summary SHALL indicate that whether the run is still being driven is unknown, and SHALL NOT present it as either live or abandoned

#### Scenario: Several runs are live at once
- **WHEN** a status is rendered without a run named and more than one run is live
- **THEN** the summary SHALL indicate that there is more than one, so the row is not read as describing the only run in the repository
