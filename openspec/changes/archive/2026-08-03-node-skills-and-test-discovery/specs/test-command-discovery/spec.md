## ADDED Requirements

### Requirement: Heuristic detection runs before any agent is spent
When determining a project's test commands, the system SHALL first apply filesystem heuristics over the repo — package manager scripts, Makefile targets, and language-specific markers — and SHALL consume no agent session and no API tokens to do so.

#### Scenario: Heuristics find candidate commands
- **WHEN** `init` runs in a repo whose `package.json` declares test scripts
- **THEN** the system SHALL offer those commands for confirmation without starting an agent session

#### Scenario: Heuristics are always attempted first
- **WHEN** test-command setup begins
- **THEN** the system SHALL attempt heuristic detection before considering the agent fallback, regardless of whether a provider is configured

### Requirement: Agent fallback proposes commands heuristics missed
When heuristic detection yields no candidates, or the user declines every candidate it produced, the system SHALL offer to determine the test commands with a single agent session granted only the `read` capability. That session SHALL propose zero or more shell commands, each with a one-line rationale naming the evidence it was derived from.

#### Scenario: Heuristics find nothing
- **WHEN** heuristic detection produces no candidate commands
- **THEN** the system SHALL offer the agent fallback rather than falling through to the placeholder command

#### Scenario: The user rejects every heuristic candidate
- **WHEN** heuristic detection produces candidates and the user declines all of them
- **THEN** the system SHALL offer the agent fallback

#### Scenario: The fallback session cannot modify the repo
- **WHEN** the agent fallback session runs
- **THEN** it SHALL be granted only the `read` capability, so it can inspect the repo but cannot edit files, run shell commands, or touch git

#### Scenario: Proposals carry their evidence
- **WHEN** the agent fallback proposes a command
- **THEN** the proposal SHALL be presented with a one-line rationale identifying what in the repo it was derived from

#### Scenario: No provider is configured
- **WHEN** the agent fallback would run but no provider and model are configured for the project
- **THEN** the system SHALL skip the fallback with an explanatory message and leave the placeholder command in place, rather than failing `init`

### Requirement: Discovered commands require confirmation before use
No command, from either heuristics or the agent fallback, SHALL be written to the workflow file without the user having been shown it and having accepted it. Test commands execute outside the capability harness, so a proposed command SHALL never run as part of proposing it.

#### Scenario: Accepting and declining proposals
- **WHEN** the user is shown a proposed command
- **THEN** the system SHALL accept it only on an explicit affirmative response, and a declined command SHALL NOT be written to the workflow file

#### Scenario: Proposals are not executed to validate them
- **WHEN** any command is proposed by heuristics or by the agent fallback
- **THEN** the system SHALL NOT execute it in order to verify it before the user has accepted it

#### Scenario: Every proposal is declined
- **WHEN** the user declines every proposed command
- **THEN** the system SHALL leave the scaffolded placeholder command in place and report that the Test node still needs a command

### Requirement: Accepted commands are persisted to the workflow file
Accepted commands SHALL be written into the Test node's `commands` list in `.flow-code/workflow.yaml`, so the commands a run executes are visible in the repo, reviewable in a diff, and identical for every run of that workflow.

#### Scenario: Commands are written back
- **WHEN** the user accepts one or more proposed commands
- **THEN** the system SHALL write them, in the order offered, to the Test node's config in the workflow file and report how many were saved

#### Scenario: Two runs of the same workflow
- **WHEN** the same workflow file is run twice with no intervening edit
- **THEN** both runs SHALL execute the same test commands

### Requirement: Test node execution remains deterministic by default
The Test node SHALL, by default, execute exactly the commands listed in its config, with no agent session, no session slot, and no token cost. The verdict of a Test node SHALL NOT depend on a model's choice of what to run.

#### Scenario: A Test node with a configured command list
- **WHEN** a Test node whose config lists commands executes
- **THEN** the system SHALL run exactly those commands and SHALL consume no agent session and no API tokens

#### Scenario: Discovery does not happen at run time
- **WHEN** a run executes a Test node configured with a command list
- **THEN** the system SHALL NOT re-derive, extend, or substitute those commands

### Requirement: Per-run rediscovery is opt-in and cannot be combined with a loop-back
The Test node's config SHALL accept `auto` in place of a command list, opting that node into rediscovering its commands at the start of each execution. Because a node that both selects and grades its own commands can escape a retry loop by selecting easier ones, the system SHALL reject, at load time, a workflow in which a loop-back edge targets any node upstream of an `auto` Test node's segment such that the Test node re-executes.

#### Scenario: Auto discovery is requested
- **WHEN** a Test node's config is `commands: auto` and no loop-back causes it to re-execute
- **THEN** the node SHALL determine its commands with a `read`-capability agent session at the start of its execution and then run them

#### Scenario: Auto combined with a loop-back
- **WHEN** a workflow declares a Test node with `commands: auto` that can re-execute via a loop-back edge
- **THEN** the system SHALL fail before starting execution with an error naming the node id and stating that rediscovery cannot be combined with retry

#### Scenario: The default remains explicit commands
- **WHEN** `init` scaffolds or updates a workflow file
- **THEN** it SHALL write an explicit command list rather than `auto`
