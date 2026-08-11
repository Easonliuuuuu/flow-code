## ADDED Requirements

### Requirement: The viewer reports which enforcement tier a run ran under
The UI SHALL indicate which enforcement tier the run it is displaying ran under — flow-code's engine executing it, a host session with flow-code's enforcement active, or self-reporting with no enforcement. The three carry materially different guarantees, and rendering them identically would present a graph as meaning more than it does for two of them.

#### Scenario: Watching a run driven from a host session
- **WHEN** the viewer is attached to a run whose run-state records a host-session tier
- **THEN** the UI SHALL indicate that tier distinctly from an engine-driven run, and SHALL make the guarantees that tier lacks discoverable without leaving the viewer

#### Scenario: Watching a self-reported run
- **WHEN** the viewer is attached to a run whose run-state records no enforcement
- **THEN** the UI SHALL indicate that the run's contents are self-reported and unverified

#### Scenario: Guarantees that did not apply are not implied
- **WHEN** the viewer displays a run whose tier does not provide token accounting or capability enforcement
- **THEN** it SHALL present those figures as unavailable rather than as zero, and SHALL NOT display capability-denial indicators as though a harness had produced them

#### Scenario: A run whose tier changed mid-run
- **WHEN** the viewer is attached to a run whose enforcement tier changed while it was running
- **THEN** the UI SHALL report the run at its weakest recorded tier rather than at the tier it opened under

#### Scenario: Watching an engine-driven run is unchanged
- **WHEN** the viewer is attached to a run driven by `flow-code run`
- **THEN** the UI SHALL present it exactly as it did before this change, with no tier indication beyond what it showed before

### Requirement: The read-only viewer is a command with a defined surface
The system SHALL provide a viewer command that renders a run it is not driving. The viewer SHALL attach to a run without loading the project's workflow file, SHALL refuse every action that would modify the run or the project, and SHALL keep following the repository rather than only the run it first attached to.

This requirement exists because the run document's rules — who may write it, what a reader may conclude about its driver, what an unnamed attach resolves to — are specified against the *document*, and a specification of the document is not a specification of the command that reads it.

#### Scenario: Attaching needs nothing but the run
- **WHEN** the viewer attaches to a run while the project's workflow file is absent, unreadable, or has been replaced
- **THEN** it SHALL render the graph the run recorded, and SHALL NOT fail or fall back to the workflow file

#### Scenario: Pinning to one run
- **WHEN** the viewer is given a run id
- **THEN** it SHALL follow that run and no other, and SHALL report a run id that does not exist rather than silently following a different run

#### Scenario: A run that starts after the viewer is open
- **WHEN** the viewer is opened with no run id and a run begins afterwards
- **THEN** it SHALL attach to that run without being restarted

#### Scenario: Every editing action is unavailable
- **WHEN** a user invokes an action that would change the run or the project from inside the viewer
- **THEN** the action SHALL be unavailable rather than attempted, and the viewer SHALL make its read-only nature visible without the user having to discover it by trying

#### Scenario: Leaving the viewer does not disturb the run
- **WHEN** the viewer is closed, by any means
- **THEN** the run it was watching SHALL be unaffected, and its document SHALL be byte-identical to what it would have been had the viewer never attached
