## MODIFIED Requirements

### Requirement: Approve and reject are available through multiple interaction surfaces
The system SHALL allow the user to approve or reject a focused Approval-Gate using the keyboard alone, with mouse interaction as an optional enhancement, in the terminal canvas. When a run is driven or observed via the MCP server, the system SHALL additionally allow approval or rejection through the MCP respond tool, with identical blocking and transition semantics to the keyboard path.

#### Scenario: Approving without a mouse
- **WHEN** the user focuses a `waiting` Approval-Gate via keyboard navigation and issues the approve action
- **THEN** the gate SHALL transition to `done`, its downstream nodes SHALL become eligible to start, and no mouse input SHALL be required

#### Scenario: Approving over MCP
- **WHEN** a `waiting` Approval-Gate belongs to a run started or observed via the MCP server, and an MCP host calls the respond tool with an approve decision for that gate
- **THEN** the gate SHALL transition to `done` and its downstream nodes SHALL become eligible to start, identically to a keyboard approval

#### Scenario: The same gate is not answered twice
- **WHEN** a gate is approved through one interaction surface
- **THEN** the system SHALL NOT accept a second decision for that gate through either surface, and SHALL report the gate as already decided
