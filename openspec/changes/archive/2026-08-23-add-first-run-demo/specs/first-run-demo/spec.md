## ADDED Requirements

### Requirement: A demo runs with no repository, no configuration, and no credentials
The system SHALL provide a `flow-code try` command that executes a complete workflow run without requiring a git repository, a `.flow-code/` directory, a configured provider, or any API credential. It SHALL take no required arguments. It SHALL NOT read or write anything outside the temporary directory it creates, and SHALL NOT make network requests.

#### Scenario: Invoked from an unconfigured machine
- **WHEN** a user runs `flow-code try` with no provider credentials present and no `claude` or `codex` login
- **THEN** the run SHALL proceed to completion without prompting for a credential and without failing preflight

#### Scenario: Invoked outside a git repository
- **WHEN** a user runs `flow-code try` from a directory that is not inside a git repository
- **THEN** the command SHALL succeed, operating entirely within the temporary repository it creates

#### Scenario: Invoked with no package installed
- **WHEN** a user runs `npx @easonliuuuuu/flow-code try`
- **THEN** the demo SHALL run using only what the published package and a stock Node 20 provide

### Requirement: The demo executes the shipped graph on the shipped engine
The demo SHALL execute the same default graph `flow-code init` scaffolds, through the same engine, executors, git operations, run-state store, and UI a real run uses. Only the agent session runner SHALL differ. The system SHALL NOT provide a separate execution path, renderer, or playback format for the demo.

#### Scenario: The demo graph is the default graph
- **WHEN** the demo's seeded workflow file is compared to the default scaffold
- **THEN** it SHALL differ only in having its test commands pre-set, and SHALL load through the same validation a hand-written workflow file passes

#### Scenario: A node type is added to the default graph
- **WHEN** the default scaffold gains a node the demo script does not cover
- **THEN** the test suite SHALL fail, rather than the demo silently skipping it

### Requirement: The demo demonstrates recovery from failure
The demo SHALL include a test that fails on its first execution and passes after the loop-back returns to the implementing node with the failure as context. The recovery SHALL be produced by the loop-back actually firing, not by a script that reports success.

#### Scenario: The test fails and the run recovers
- **WHEN** the demo run reaches its test node for the first time
- **THEN** the node SHALL fail on a real non-zero exit code, execution SHALL return to the implementing node, and the subsequent test execution SHALL pass

#### Scenario: The loop-back is what produced the recovery
- **WHEN** the demo run completes
- **THEN** the run-state SHALL record more than one attempt at the implementing node

### Requirement: The demo demonstrates approval before git
The demo SHALL pause at every approval gate the graph declares and SHALL require a human decision at each. The diff presented SHALL be computed from the repository by the same mechanism a real run uses. The system SHALL NOT auto-approve, skip, or time out a gate during the demo.

#### Scenario: The gate holds a real diff
- **WHEN** the demo reaches the gate preceding git operations
- **THEN** the diff shown SHALL be derived from the git tree before and after the implementing node's session, and SHALL be non-empty

#### Scenario: Nothing is committed without approval
- **WHEN** the user rejects at the gate preceding git operations
- **THEN** no commit SHALL be made, and execution SHALL follow the rejection edge the graph declares

### Requirement: The demo discloses that it is scripted for its whole duration
The UI SHALL display, for the entire demo run, a persistent indication that no live agent is running and no tokens are being spent. The indication SHALL NOT be dismissible and SHALL NOT depend on the closing summary. Where the demo behaves differently from a real run — an interactive node concluded from a script rather than by conversation — that node SHALL disclose it in its own output.

#### Scenario: The banner is present throughout
- **WHEN** any frame of a demo run is rendered
- **THEN** it SHALL contain the disclosure

#### Scenario: A normal run carries no such banner
- **WHEN** a run is started by `flow-code run`
- **THEN** no demo disclosure SHALL be rendered

#### Scenario: A scripted conversation is marked
- **WHEN** an interactive node is concluded from the script rather than by the user
- **THEN** that node's output SHALL state that the exchange was scripted

### Requirement: The demo leaves an inspectable artifact
On completion the system SHALL retain the temporary repository and SHALL report its path, the path of its workflow file, and how to configure a real project. The retained repository SHALL contain the run's real git history and run-state.

#### Scenario: The run reports where its work is
- **WHEN** the demo completes
- **THEN** the summary SHALL name the repository path, the workflow file path, and `flow-code init`

#### Scenario: The artifact is real
- **WHEN** the retained repository is inspected after the demo
- **THEN** it SHALL contain a commit produced by the run and a run-state document describing it

### Requirement: The demo refuses to run where it cannot ask for approval
Because the demo blocks on approval gates, the system SHALL detect the absence of an interactive terminal before starting and SHALL fail with a message naming that as the reason. It SHALL NOT hang, and SHALL NOT proceed by approving a gate on the user's behalf.

#### Scenario: No TTY
- **WHEN** `flow-code try` is invoked with stdin not a TTY
- **THEN** it SHALL exit non-zero with a message explaining that the demo pauses for approval and needs an interactive terminal
