# test-command-discovery Specification

## Purpose

Defines how a project's test commands are determined — filesystem heuristics first, then a `read`-only agent session — how proposals are confirmed by the user and persisted into the Test node's config in `.flow-code/workflow.yaml`, and the constraints that keep Test node execution deterministic across the attempts of a run.

## Requirements

### Requirement: Heuristic detection runs before any agent is spent
When determining a project's test commands, the system SHALL first apply filesystem heuristics over the repo — package manager scripts, Makefile targets, and language-specific markers — and SHALL consume no agent session and no API tokens to do so.

#### Scenario: Heuristics find candidate commands
- **WHEN** determination runs in a repo whose `package.json` declares test scripts
- **THEN** those commands SHALL be among the candidates offered for confirmation, derived without an agent session and without waiting on one

#### Scenario: Heuristics are always attempted first
- **WHEN** test-command setup begins
- **THEN** the system SHALL attempt heuristic detection before considering the agent fallback, regardless of whether a provider is configured

### Requirement: An agent pass runs before the user is asked
Determination SHALL complete both passes — the heuristics, then a single agent session granted only the `read` capability — before presenting anything for confirmation, so what the user is shown is a filled-in answer to accept rather than an empty prompt with work left to do. That session SHALL propose zero or more shell commands, each with a one-line rationale naming the evidence it was derived from. Heuristics running first is what keeps the free source free; it is not a reason to stop.

#### Scenario: Both passes complete before the prompt
- **WHEN** a Test node with no configured commands reaches execution
- **THEN** the system SHALL run the heuristics and the agent pass, and SHALL present their combined candidates together, without requiring the user to ask for either

#### Scenario: The agent session cannot modify the repo
- **WHEN** the agent pass runs
- **THEN** it SHALL be granted only the `read` capability, so it can inspect the repo but cannot edit files, run shell commands, or touch git

#### Scenario: Proposals carry their evidence
- **WHEN** the agent pass proposes a command
- **THEN** the proposal SHALL be presented with a one-line rationale identifying what in the repo it was derived from

#### Scenario: The agent pass fails or finds nothing
- **WHEN** the agent pass cannot run — no provider configured, or the session errors — or completes with no proposals
- **THEN** the system SHALL still present whatever the heuristics found, together with the reason the agent pass produced nothing, and SHALL NOT fail the node

#### Scenario: A further look is asked for
- **WHEN** the user asks for another agent pass from the confirmation prompt
- **THEN** the system SHALL run one more `read`-only session and fold its proposals in alongside the existing candidates, without discarding a selection the user has already made

### Requirement: Discovered commands require confirmation before use
No command, from either heuristics or the agent fallback, SHALL be written to the workflow file without the user having been shown it and having accepted it. Test commands execute outside the capability harness, so a proposed command SHALL never run as part of proposing it.

#### Scenario: Accepting and declining proposals
- **WHEN** the user is shown a proposed command
- **THEN** the system SHALL accept it only on an explicit affirmative response, and a declined command SHALL NOT be written to the workflow file

#### Scenario: Proposals are not executed to validate them
- **WHEN** any command is proposed by heuristics or by the agent fallback
- **THEN** the system SHALL NOT execute it in order to verify it before the user has accepted it

#### Scenario: Candidates start selected
- **WHEN** the confirmation prompt is presented
- **THEN** every candidate found SHALL start selected, so that accepting is a single action and the work of the prompt is deselecting what does not belong — this is a default, not an acceptance, and nothing is written or run until the user confirms

#### Scenario: Every candidate is declined
- **WHEN** the user declines every candidate, or dismisses the prompt
- **THEN** the system SHALL write nothing to the workflow file, SHALL run no commands, and SHALL complete the node reporting that it has no test command configured

### Requirement: Accepted commands are persisted to the workflow file
Accepted commands SHALL be written into the Test node's `commands` list in `.flow-code/workflow.yaml`, so the commands a run executes are visible in the repo, reviewable in a diff, and identical for every run of that workflow.

#### Scenario: Commands are written back
- **WHEN** the user accepts one or more proposed commands
- **THEN** the system SHALL write them, in the order offered, to the Test node's config in the workflow file and report how many were saved

#### Scenario: Two runs of the same workflow
- **WHEN** the same workflow file is run twice with no intervening edit
- **THEN** both runs SHALL execute the same test commands

### Requirement: A Test node runs the same commands on every attempt of a run
Once a Test node's commands are settled they SHALL NOT change for the remainder of the run: every retry SHALL be graded against the commands the first attempt was. Determination SHALL therefore happen at most once per node per run, and a node carrying a command list SHALL consume no agent session, no session slot, and no token cost to run it. The verdict of a Test node SHALL NOT depend on a model's choice of what to run.

#### Scenario: A Test node with a configured command list
- **WHEN** a Test node whose config lists commands executes
- **THEN** the system SHALL run exactly those commands and SHALL consume no agent session and no API tokens

#### Scenario: Discovery does not happen at run time
- **WHEN** a run executes a Test node configured with a command list
- **THEN** the system SHALL NOT re-derive, extend, or substitute those commands

#### Scenario: A workflow file predating in-node determination
- **WHEN** a Test node's configured command list is exactly the placeholder command that earlier versions scaffolded in place of a real one
- **THEN** the node SHALL be treated as never having been configured and SHALL determine its commands as if the key were absent, because that placeholder runs and exits zero — executing it would report a passing suite for a node nobody ever configured

#### Scenario: A loop-back re-runs a node that determined its own commands
- **WHEN** a Test node determined and persisted its commands, and a loop-back later re-runs it
- **THEN** it SHALL run the persisted commands and SHALL NOT ask again or re-derive them, so no retry can be graded against an easier suite than the attempt before it

### Requirement: Per-execution rediscovery is opt-in and cannot be combined with a loop-back
The Test node's config SHALL accept `auto` in place of a command list, opting that node into rediscovering its commands at the start of every execution and persisting nothing — for a workflow pointed at repositories that differ from run to run. Because a node that both selects and grades its own commands would then get several attempts to select easier ones, the system SHALL reject, at load time, a workflow in which a loop-back edge targets any node upstream of an `auto` Test node's segment such that the Test node re-executes. This SHALL NOT extend to a node that determines its commands once and persists them, which runs the same commands on every later attempt.

#### Scenario: Auto discovery is requested
- **WHEN** a Test node's config is `commands: auto` and no loop-back causes it to re-execute
- **THEN** the node SHALL determine its commands with a `read`-capability agent session at the start of its execution and then run them

#### Scenario: Auto combined with a loop-back
- **WHEN** a workflow declares a Test node with `commands: auto` that can re-execute via a loop-back edge
- **THEN** the system SHALL fail before starting execution with an error naming the node id and stating that rediscovery cannot be combined with retry

#### Scenario: The scaffolded default determines and persists
- **WHEN** `init` scaffolds a workflow file
- **THEN** its Test nodes SHALL carry no `commands` key — determining, confirming and persisting on first execution — and SHALL NOT be scaffolded as `auto`, whose per-execution rediscovery is the mode this restriction exists to constrain
