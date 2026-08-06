## MODIFIED Requirements

### Requirement: Skills never widen a node's capability envelope
Attached skills SHALL NOT change the capability set compiled into a node's enforced tool policy. A tool call a skill's instructions ask for that the node's capabilities do not permit SHALL be denied by the existing harness, and the denial SHALL be recorded in the node's activity log like any other denial. This SHALL hold for calls a skill causes a subagent to make as much as for calls made in the node's own session.

#### Scenario: A skill asks for a tool the node lacks
- **WHEN** a skill attached to a Review node instructs the agent to run a shell command and the Review type has no `exec` capability
- **THEN** the call SHALL be denied, the denial SHALL appear in the node's activity log, and the node SHALL continue within its role

#### Scenario: Skills cannot grant network access
- **WHEN** an attached skill instructs the agent to fetch a URL
- **THEN** network-capable tools SHALL remain unavailable, as they are for every node in this version

#### Scenario: A skill that delegates cannot escape the envelope
- **WHEN** an attached skill instructs the agent to spawn a subagent and have it perform work the node's capability set does not permit
- **THEN** the subagent's offending tool calls SHALL be denied against the parent node's capability set, and the denials SHALL appear in the node's activity log
