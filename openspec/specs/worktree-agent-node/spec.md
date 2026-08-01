# worktree-agent-node Specification

## Purpose

Defines the Worktree-Agent node type: isolated git-worktree fan-out with per-instance agent sessions, compare and parallelize configuration modes, the user-driven convergence step, the downstream working directory after convergence, and worktree cleanup including crash reconciliation.

## Requirements

### Requirement: Isolated worktree fan-out
The Worktree-Agent node type SHALL create one isolated `git worktree` on its own branch per configured fan-out instance, and run an independent Claude Agent SDK session scoped to each worktree's directory. Worktree-Agent instances are the only executions permitted to run concurrently with one another.

#### Scenario: Fan-out with 3 instances
- **WHEN** a Worktree-Agent node is configured with 3 instances
- **THEN** the system SHALL create 3 separate git worktrees, each on its own branch, and run 3 independent agent sessions concurrently, subject to the global concurrency cap

#### Scenario: Instance sessions are confined to their worktree
- **WHEN** an instance's agent session is started
- **THEN** its working directory SHALL be that instance's worktree, and the capability harness SHALL deny file operations resolving outside it

### Requirement: Configurable fan-out mode
The Worktree-Agent node SHALL support two configuration modes: "compare" (same task, differing instructions or model per instance) and "parallelize" (distinct sub-tasks per instance), selected via node config.

#### Scenario: Compare mode
- **WHEN** a Worktree-Agent node is configured in "compare" mode with per-instance instruction overrides
- **THEN** each instance SHALL receive the same base task plus its own instruction override

#### Scenario: Parallelize mode
- **WHEN** a Worktree-Agent node is configured in "parallelize" mode with a list of distinct sub-tasks
- **THEN** each instance SHALL receive exactly one distinct sub-task from that list

### Requirement: Convergence step
After all fan-out instances complete, the system SHALL present their results (diff and summary per branch) and require the user to select which branch or branches proceed downstream before any subsequent node runs.

#### Scenario: All instances complete
- **WHEN** every fan-out instance of a Worktree-Agent node reaches `done` or `error`
- **THEN** the system SHALL render a convergence view listing each instance's branch, its diff summary, and its status, and SHALL NOT start downstream nodes until the user selects an outcome

#### Scenario: Compare mode selects exactly one branch
- **WHEN** a Worktree-Agent node configured in "compare" mode reaches convergence
- **THEN** the system SHALL require the user to select exactly one branch, and that branch's worktree SHALL become the working directory for downstream nodes

#### Scenario: Parallelize mode selects one or more branches
- **WHEN** a Worktree-Agent node configured in "parallelize" mode reaches convergence and the user selects more than one branch
- **THEN** the system SHALL merge the selected branches into a single working directory before starting downstream nodes

#### Scenario: Merge conflict during convergence
- **WHEN** merging the user's selected branches produces a conflict
- **THEN** the system SHALL set the Worktree-Agent node to `error`, report which files conflicted, and SHALL NOT start downstream nodes

### Requirement: Downstream working directory after convergence
The system SHALL record the working directory that downstream nodes operate in after convergence, and that directory SHALL remain intact for the remainder of the run.

#### Scenario: Downstream node runs after convergence
- **WHEN** a node downstream of a Worktree-Agent node starts
- **THEN** its working directory SHALL be the converged working directory recorded at convergence, not the repository's original main working tree

#### Scenario: Selected worktree is retained
- **WHEN** convergence completes and the run proceeds
- **THEN** the worktree backing the converged working directory SHALL be retained until the run reaches a terminal state

### Requirement: Worktree cleanup and crash reconciliation
The system SHALL track every worktree it creates in run-state, remove worktrees that are no longer needed, and reconcile orphaned worktrees from a prior crashed run on next launch.

#### Scenario: Non-selected instances are cleaned up
- **WHEN** the user selects an outcome at convergence and the run proceeds
- **THEN** the system SHALL remove the git worktrees for the non-selected instances, and retain the converged one

#### Scenario: Reconciling after a crash
- **WHEN** flow-code starts and finds worktrees recorded in run-state that no longer correspond to a running process
- **THEN** the system SHALL offer to clean up those orphaned worktrees before starting a new run

#### Scenario: Explicit cleanup command
- **WHEN** the user runs `flow-code doctor`
- **THEN** the system SHALL list every worktree recorded in run-state that has no running process, and offer to remove them
