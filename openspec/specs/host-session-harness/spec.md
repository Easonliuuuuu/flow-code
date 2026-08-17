# host-session-harness Specification

## Purpose

Defines what flow-code enforces inside a host agent session it did not start: the current node's capability envelope applied to that session's tool calls through the same policy an engine-driven run uses, git writes held behind an undecided gate, gate decisions that must come from a person, delegated work carrying its delegator's envelope, and failure that closes rather than opens. A run claims only the enforcement it can demonstrate.

## Requirements
### Requirement: A node's capability envelope applies to the host session
When a run is driven from a host agent session the plugin has instrumented, the system SHALL apply the capability set of the run's current node to that session's own tool calls, using the same compiled tool policy an engine-driven run applies. A node's envelope SHALL NOT depend on which process is executing it.

#### Scenario: A tool outside the current node's capability set
- **WHEN** the run's current node is a node type without the `edit` capability, and the host session attempts a file-writing tool call
- **THEN** the system SHALL deny the call before it runs and SHALL return the same reason an engine-driven denial returns, naming the missing capability

#### Scenario: A tool inside the current node's capability set
- **WHEN** the run's current node holds the `edit` capability and the host session attempts a file-writing tool call
- **THEN** the system SHALL allow the call, and SHALL NOT require the user to answer a prompt that an engine-driven run would not have raised

#### Scenario: The envelope moves with the run
- **WHEN** the run advances from a node holding a capability to a node that does not hold it
- **THEN** a tool call permitted before the transition SHALL be denied after it, without the session being restarted

#### Scenario: Denials are recorded like any other
- **WHEN** a tool call is denied by host-session enforcement
- **THEN** the denial SHALL be recorded in run-state's activity log with the node it was denied under and the missing capability, in the same shape an engine-driven denial is recorded

### Requirement: Git writes stay behind an unapproved gate in a host session
The system SHALL refuse repository-mutating git operations from an instrumented host session while an upstream Approval-Gate for the run is undecided or rejected, matching engine-driven behavior. The interception SHALL reuse the same command classification the engine uses, so the two paths cannot disagree about what counts as a write.

#### Scenario: A commit attempted before the gate is answered
- **WHEN** the host session attempts a git command that writes to the repository while the run's Approval-Gate is `waiting`
- **THEN** the system SHALL deny the command and SHALL state that the gate has not been approved

#### Scenario: A push attempted after the gate is rejected
- **WHEN** the run's Approval-Gate has been rejected and the host session attempts a git push
- **THEN** the system SHALL deny the command

#### Scenario: Read-only git is unaffected
- **WHEN** the host session runs a git command that only reads repository state while the gate is `waiting`
- **THEN** the system SHALL allow it

### Requirement: A gate decision in a host session comes from a person
The system SHALL require a human interaction that a host-side automation cannot silently satisfy before recording an Approval-Gate decision made in a host session. A decision produced without one SHALL NOT be recorded as an approval.

#### Scenario: The approval surface requires an explicit human answer
- **WHEN** the plugin requests a gate decision from the host session
- **THEN** the request SHALL be made through a surface that requires the user to answer it directly, and SHALL NOT be satisfiable by a host configuration that answers prompts automatically

#### Scenario: An automated response does not approve a gate
- **WHEN** the host is configured to respond to the plugin's requests automatically and such a response arrives for a gate
- **THEN** the system SHALL NOT record the gate as approved, and SHALL report why the decision was refused

#### Scenario: A recorded decision names its surface
- **WHEN** a gate decision is recorded from a host session
- **THEN** run-state SHALL record which surface produced it, so an approval can be attributed after the fact

### Requirement: Enforcement fails closed
When the system cannot determine whether a tool call is permitted — the enforcement layer errors, times out, or cannot read the run's state — it SHALL deny the call rather than allow it.

#### Scenario: Run-state cannot be read
- **WHEN** the enforcement layer cannot read the run's state document while resolving a tool call
- **THEN** the call SHALL be denied with a reason naming the failure, and the failure SHALL NOT be reported as a capability denial

#### Scenario: The enforcement layer errors
- **WHEN** the enforcement layer exits abnormally while resolving a tool call
- **THEN** the call SHALL be denied

### Requirement: Delegated work carries the delegating node's envelope
When an instrumented host session delegates a node's work to a subagent, the system SHALL apply the delegating node's capability set to that subagent's tool calls, so delegation cannot widen what a node may do.

#### Scenario: A subagent attempts a tool its node lacks
- **WHEN** a subagent running a node's work attempts a tool call outside that node's capability set
- **THEN** the system SHALL deny the call, identically to the same attempt made by the session directly

#### Scenario: Delegated work is attributed to its node
- **WHEN** a subagent running a node's work makes tool calls
- **THEN** run-state SHALL attribute that activity to the delegating node

### Requirement: A run claims only the enforcement it can demonstrate
The system SHALL verify that host-session enforcement is actually in force before recording a run at an enforcement tier that claims it, and SHALL record the lower tier when verification fails. An installed plugin SHALL NOT be treated as evidence that its enforcement is active.

#### Scenario: Enforcement is verified at run open
- **WHEN** a run is opened from a host session
- **THEN** the system SHALL verify that its enforcement layer is active before recording the run's tier

#### Scenario: Enforcement is not active
- **WHEN** verification shows the enforcement layer is not active — disabled, not installed, or unsupported by the host
- **THEN** the system SHALL record the run at the self-reported tier and SHALL tell the user that the run carries no capability enforcement

#### Scenario: Enforcement is disabled mid-run
- **WHEN** enforcement stops being active during a run
- **THEN** the system SHALL record that the run's tier changed and from which point, rather than presenting the whole run at its opening tier
