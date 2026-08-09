## ADDED Requirements

### Requirement: A workflow file may declare multiple named graphs
The workflow file SHALL support declaring more than one named graph, each with its own nodes and edges, so a repo can carry several shapes of the same process — for example a short one and a heavily verified one — in one reviewable file. Run-wide `settings` SHALL be declared once and apply to whichever graph is selected. A file declaring a single unnamed graph SHALL remain valid and keep its current meaning.

#### Scenario: A single-graph file
- **WHEN** a workflow file declares nodes and edges at the top level with no named graphs
- **THEN** the system SHALL load it exactly as it does today, and `flow-code run` SHALL execute it without asking anything

#### Scenario: A file declaring named graphs
- **WHEN** a workflow file declares named graphs
- **THEN** each named graph SHALL be validated independently against every node, config, settings, and structural check, and the file SHALL be invalid if any one of them is

#### Scenario: A file declaring both forms
- **WHEN** a workflow file declares both top-level nodes and named graphs
- **THEN** the system SHALL reject it rather than resolving the ambiguity by precedence

#### Scenario: A named graph declaring its own budget
- **WHEN** a named graph declares a `budget`
- **THEN** the system SHALL reject the file, naming the graph — a ceiling the shape may raise is not a ceiling, and a shape needing more work carries more nodes with their own per-node budgets

#### Scenario: A name that matches no graph
- **WHEN** a run is asked for a graph name the file does not declare
- **THEN** the system SHALL fail before starting execution, naming the requested graph and listing the names the file does declare

#### Scenario: Validation covers every declared graph
- **WHEN** the user runs `flow-code validate` on a file declaring named graphs
- **THEN** the report SHALL identify which graph each failure belongs to, so a failure in one shape is not mistaken for a failure in another

### Requirement: A run selects which declared graph it executes
When the workflow file declares more than one named graph, `flow-code run` SHALL establish which one this run executes before any node starts, and SHALL make the selected name visible for the duration of the run. The selection SHALL be answerable interactively, and SHALL also be specifiable without a prompt so a non-interactive run is not blocked on one.

#### Scenario: Interactive selection
- **WHEN** the user runs `flow-code run` in a terminal against a file declaring named graphs and does not name one
- **THEN** the system SHALL ask which to run, offering every declared name with its description, and SHALL start no node until the question is answered

#### Scenario: Selection given up front
- **WHEN** a run is started naming a declared graph
- **THEN** the system SHALL execute that graph without asking, and the run SHALL record which name it selected

#### Scenario: No terminal to ask in
- **WHEN** a run is started without a terminal against a file declaring named graphs and no name is given
- **THEN** the system SHALL fail before starting execution rather than choosing a graph on the user's behalf

#### Scenario: The selected name is visible during the run
- **WHEN** a run is executing a named graph
- **THEN** the name SHALL be reported on screen, so which shape is running is legible without comparing the graph to the file
