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
