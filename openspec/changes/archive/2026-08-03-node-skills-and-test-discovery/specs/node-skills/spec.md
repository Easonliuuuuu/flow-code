## ADDED Requirements

### Requirement: Skill discovery across project, user, and plugin roots
The system SHALL discover skills from three roots — the repo's `.claude/skills/`, the user's `~/.claude/skills/`, and installed plugin marketplaces under `~/.claude/plugins/` — where a skill is a directory containing a `SKILL.md` with `name` and `description` frontmatter. Project-root skills SHALL shadow user-root skills of the same name, and plugin-provided skills SHALL be addressed by a namespaced `plugin:skill` identifier so they cannot collide with local names.

#### Scenario: A skill exists in the project root
- **WHEN** the repo contains `.claude/skills/house-review/SKILL.md`
- **THEN** the system SHALL discover a skill named `house-review` and record its source root as the project

#### Scenario: The same skill name exists in both project and user roots
- **WHEN** a skill name is present in both `.claude/skills/` and `~/.claude/skills/`
- **THEN** the system SHALL resolve that name to the project-root skill

#### Scenario: A plugin marketplace provides a skill
- **WHEN** an installed plugin marketplace provides a skill
- **THEN** the system SHALL discover it under a `plugin:skill` identifier and SHALL NOT allow it to shadow, or be shadowed by, an unqualified project or user skill name

#### Scenario: A directory without SKILL.md
- **WHEN** a directory under a skill root contains no `SKILL.md`
- **THEN** the system SHALL ignore it rather than reporting an error

### Requirement: Skills attach to agent-driven nodes
An agent-driven node's config SHALL accept a `skills` list naming zero or more skills, each entry being a discovered skill identifier or a filesystem path relative to the repo root. The listed skills SHALL be composed in declaration order, so a later entry can layer on an earlier one.

#### Scenario: A node names one skill
- **WHEN** a Review node's config lists a single resolvable skill
- **THEN** that skill's instructions SHALL govern how the node performs its work

#### Scenario: A node names several skills
- **WHEN** a node's config lists more than one skill
- **THEN** the system SHALL compose them in the order written in the config

#### Scenario: A node names a skill by path
- **WHEN** a `skills` entry is a path relative to the repo root that contains a `SKILL.md`
- **THEN** the system SHALL resolve it directly, without consulting the discovery roots

#### Scenario: Skills on a node type with no agent session
- **WHEN** a workflow file lists `skills` on a Test or Approval-Gate node
- **THEN** the system SHALL fail before starting execution with an error naming the node id and stating that the type runs no agent session

### Requirement: Skills resolve before the run starts
The system SHALL resolve every `skills` entry in the workflow file at load time. An entry that resolves to no skill SHALL be a validation error that prevents the run from starting, rather than a failure raised when the node executes.

#### Scenario: An unresolvable skill name
- **WHEN** a node lists a skill name that matches nothing in any discovery root and is not a valid path
- **THEN** the system SHALL fail before starting execution with an error naming the node id, the unresolved entry, and the roots that were searched

#### Scenario: All skills resolve
- **WHEN** every `skills` entry across the workflow resolves
- **THEN** the system SHALL proceed to execution and SHALL NOT re-resolve skills during the run

### Requirement: Skill portability is reported before the run
Because the workflow file is checked into the repo while user-root and plugin skills are not, preflight SHALL report, for each resolved skill, the root it resolved from, and SHALL call out skills resolved from the user root or a plugin as skills that will not resolve on another checkout of the same repo. This SHALL be a warning, not a failure.

#### Scenario: A node uses a user-root skill
- **WHEN** preflight runs on a workflow whose node resolves a skill from `~/.claude/skills/`
- **THEN** the system SHALL warn that this skill is not part of the repo and the run SHALL still proceed

#### Scenario: Every skill is project-local
- **WHEN** every resolved skill came from the repo's own `.claude/skills/`
- **THEN** preflight SHALL emit no portability warning

### Requirement: Discoverable skills can be listed
The system SHALL provide a command that lists every discoverable skill with its identifier, its `description` frontmatter, and the root it was discovered from, so a user can see what is attachable before editing the workflow file.

#### Scenario: Listing skills
- **WHEN** the user runs the skills listing command in a repo
- **THEN** the system SHALL print each discoverable skill's identifier, description, and source root

#### Scenario: A skill declares a compatibility requirement
- **WHEN** a discovered skill's frontmatter carries a `compatibility` field
- **THEN** the system SHALL surface that field in the environment diagnostic command, so an unmet external dependency is visible before it fails mid-run

### Requirement: Skills compose into the system prompt provider-agnostically
Resolved skill bodies SHALL be composed into the node's session as system-prompt text placed ahead of the node type's role prompt, using the same session request path for every provider runner. The system SHALL NOT depend on any provider-specific skill-loading mechanism, and SHALL NOT execute scripts bundled alongside a `SKILL.md`.

#### Scenario: The same skill on different providers
- **WHEN** a node carrying a skill runs under the Claude runner and, in another run, under an OpenAI-compatible runner
- **THEN** the skill's instructions SHALL be present in both sessions

#### Scenario: A skill bundles auxiliary files
- **WHEN** a resolved skill directory contains files other than `SKILL.md`
- **THEN** the system SHALL compose only the `SKILL.md` body and SHALL NOT execute or auto-load the other files

### Requirement: The node type owns the output contract
A node type's output-shape instruction SHALL be composed after any skill text, so the node's declared output schema, failure predicate, and graph routing behave identically whether or not skills are attached.

#### Scenario: A skill prescribes its own report format
- **WHEN** a skill attached to a Review node instructs the agent to produce a prose report
- **THEN** the node SHALL still be required to emit output conforming to the Review output schema, and its verdict SHALL still drive routing

#### Scenario: Routing is unchanged by skills
- **WHEN** a node with attached skills produces output satisfying its type's failure predicate
- **THEN** the node SHALL reach `error` and loop-back routing SHALL behave exactly as it does for a node with no skills

### Requirement: Skills never widen a node's capability envelope
Attached skills SHALL NOT change the capability set compiled into a node's enforced tool policy. A tool call a skill's instructions ask for that the node's capabilities do not permit SHALL be denied by the existing harness, and the denial SHALL be recorded in the node's activity log like any other denial.

#### Scenario: A skill asks for a tool the node lacks
- **WHEN** a skill attached to a Review node instructs the agent to run a shell command and the Review type has no `exec` capability
- **THEN** the call SHALL be denied, the denial SHALL appear in the node's activity log, and the node SHALL continue within its role

#### Scenario: Skills cannot grant network or subagent access
- **WHEN** an attached skill instructs the agent to fetch a URL or spawn a subagent
- **THEN** those tools SHALL remain unavailable, as they are for every node in this version

### Requirement: Node types declare whether they are interactive
The built-in node type registry SHALL record, per type, whether the type is interactive — meaning it holds at `waiting` and consumes user turns during its session. The Discuss type SHALL be the only interactive type. This property SHALL be enforced rather than documentary: a non-interactive node SHALL have no channel on which to block for user input.

#### Scenario: Discuss is interactive
- **WHEN** the node type registry is inspected
- **THEN** the Discuss type SHALL be marked interactive and every other type SHALL NOT be

#### Scenario: A non-interactive node cannot wait for a user
- **WHEN** an Implement, Spec, Validate, Review, or Git-ops node executes
- **THEN** the system SHALL NOT expose a user-input channel to its session, so the node cannot block awaiting a user turn

### Requirement: A non-interactive session ending in a question fails legibly
When a non-interactive node's session ends without producing output conforming to its type's output schema, and the session's final response is a request for user input rather than the required output, the node SHALL fail with a status detail naming that cause, so the failure is distinguishable from a malformed-output error and can be routed by an existing loop-back edge.

#### Scenario: A skill written for interactive use lands on a headless node
- **WHEN** a skill attached to an Implement node causes the session to end by asking the user a clarifying question instead of producing the node's required output
- **THEN** the node SHALL reach `error` with a status detail stating that the session ended by asking a question and that the node is non-interactive

#### Scenario: The failure is routable
- **WHEN** a node fails for this reason and a loop-back edge targets it or its upstream
- **THEN** that edge SHALL carry the failure exactly as it does for any other node failure, within its configured attempt bound

#### Scenario: Malformed output is reported differently
- **WHEN** a non-interactive node's session produces output that is present but does not conform to the type's schema
- **THEN** the node SHALL fail with a status detail identifying the schema violation, not the interactivity cause
