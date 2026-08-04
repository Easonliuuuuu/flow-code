## ADDED Requirements

### Requirement: Guest-driven runs are distinguishable from engine-driven runs
The UI SHALL indicate when the run it is displaying was driven by an external agent rather than by flow-code's own engine. The two carry materially different guarantees — a guest run has no capability enforcement, no token accounting, and no engine-driven loop-backs — and rendering them identically would present a graph as meaning more than it does.

#### Scenario: Watching a guest-driven run
- **WHEN** the viewer is attached to a run whose run-state records it as guest-driven
- **THEN** the UI SHALL indicate that the run is guest-driven, distinctly from how it presents an engine-driven run

#### Scenario: Guarantees that did not apply are not implied
- **WHEN** the viewer displays a guest-driven run
- **THEN** it SHALL NOT present token totals or capability-denial indicators as though a harness had produced them, and SHALL make clear that those figures are unavailable rather than zero

#### Scenario: Watching an engine-driven run is unchanged
- **WHEN** the viewer is attached to a run driven by `flow-code run`
- **THEN** the UI SHALL present it exactly as it did before guest mode existed, with no guest-mode indication
