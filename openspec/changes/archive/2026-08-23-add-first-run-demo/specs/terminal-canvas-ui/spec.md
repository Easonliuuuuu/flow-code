## ADDED Requirements

### Requirement: The header carries a run-mode disclosure row
The header SHALL support a disclosure row rendered above the canvas, on the same conditional-row mechanism the guarantee-tier disclosure uses. When present it SHALL be counted in the header's row budget, so the canvas loses no row it believes it has.

#### Scenario: The row is budgeted
- **WHEN** a disclosure row is rendered
- **THEN** the canvas height SHALL be reduced by exactly that row, and no content SHALL be pushed off the bottom of the viewport

#### Scenario: The row survives a resize
- **WHEN** the terminal is resized while a disclosure row is present
- **THEN** the row SHALL remain, and the canvas SHALL re-budget against the new size
