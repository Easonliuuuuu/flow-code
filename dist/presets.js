import { DEFAULT_WORKFLOW_YAML } from './defaultWorkflow.js';
import { PLACEHOLDER_TEST_COMMAND } from './registry/index.js';
const OPENSPEC_YAML = `# flow-code workflow (openspec preset) — checked into your repo, edit as needed.
# Run \`flow-code node-types\` for every node type, and \`flow-code skills\` for
# every skill you can attach to one.
#
# Each node here is a built-in type carrying an openspec skill: the skill says
# how the step works, the node type still owns what it must return and how the
# graph routes it.

settings:
  concurrency: 1

  budget:
    tokensPerNode: 300000
    tokensPerRun: 2000000
    minutesPerRun: 60

nodes:
  # Explore is the one node that can stop and ask you things — Discuss is the
  # only interactive node type. Every node below it runs headless, which is why
  # the questions belong here: this is where they can still be answered.
  - id: explore
    type: discuss
    config:
      topic: What should this change accomplish?
      skills: [openspec-explore]

  - id: propose
    type: spec
    config:
      skills: [openspec-propose]

  - id: apply
    type: implement
    config:
      instructions: Implement the tasks in the openspec change, including tests covering them.
      skills: [openspec-apply-change]

  - id: test
    type: test
    config:
      commands:
        - ${PLACEHOLDER_TEST_COMMAND}

  - id: validate
    type: validate

  - id: gate
    type: approval-gate
    config:
      title: Review the pending diff before archiving the change

  - id: archive
    type: git-ops
    config:
      skills: [openspec-archive-change]

edges:
  - { from: explore, to: propose }
  - { from: propose, to: apply }
  - { from: apply, to: test }
  - { from: test, to: validate }
  # Validate is judged against the proposal's acceptance criteria, so it
  # depends on \`propose\` directly — and that dependency is also what keeps a
  # retry from rewriting the contract it is being judged against.
  - { from: propose, to: validate }
  - { from: validate, to: gate }
  - { from: gate, to: archive }

  - { from: test, to: apply, loopback: { maxAttempts: 3 } }
  - { from: validate, to: apply, loopback: { maxAttempts: 3 } }
`;
const SPEC_KIT_YAML = `# flow-code workflow (spec-kit preset) — checked into your repo, edit as needed.
# Run \`flow-code node-types\` for every node type, and \`flow-code skills\` for
# every skill you can attach to one.
#
# Shaped after GitHub Spec Kit's specify → plan → tasks → implement loop,
# built from the same node types every other preset uses — Spec Kit is a
# methodology, not a new kind of node. "tasks" has no node of its own: an
# Implement node's own agent turn breaks its instructions into whatever
# tasks satisfy them as a normal part of implementing, the same way it
# already would without a name for that step. Unlike the openspec preset,
# this one names no \`skills:\` — there's no single canonical Spec Kit skill
# package to point at, so attach one yourself (\`flow-code skills\`) if you
# have it, or leave every step on its built-in role prompt.

settings:
  concurrency: 1

  budget:
    tokensPerNode: 300000
    tokensPerRun: 2000000
    minutesPerRun: 60

nodes:
  # Specify is the one node that can stop and ask you things — Discuss is
  # the only interactive node type. Everything below it runs headless, so
  # ambiguity has to be resolved here, not further down the graph.
  - id: specify
    type: discuss
    config:
      topic: >-
        What should this feature accomplish? Capture the user scenarios and
        requirements — not the implementation — before any design starts.
      # skills: [your-spec-kit-skill]

  - id: plan
    type: spec
    # No config: the technical plan and acceptance criteria are derived from
    # the specify discussion above. To write them by hand instead:
    #   config:
    #     title: What we're building
    #     acceptanceCriteria:
    #       - Running \`foo --bar\` prints the parsed config and exits 0

  - id: implement
    type: implement
    config:
      instructions: >-
        Implement the plan above: break it into the tasks needed to satisfy
        every acceptance criterion, including tests covering them.

  - id: test
    type: test
    config:
      commands:
        - ${PLACEHOLDER_TEST_COMMAND}

  - id: validate
    type: validate

  - id: gate
    type: approval-gate
    config:
      title: Review the pending diff before git operations

  - id: git-ops
    type: git-ops
    # Commits only. To push, add:
    # config:
    #   push: { remote: origin, branch: my-branch }

edges:
  - { from: specify, to: plan }
  - { from: plan, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
  # Validate is judged against the plan's acceptance criteria, so it depends
  # on \`plan\` directly — and that dependency is also what keeps a retry from
  # rewriting the contract it is being judged against.
  - { from: plan, to: validate }
  - { from: validate, to: gate }
  - { from: gate, to: git-ops }

  - { from: test, to: implement, loopback: { maxAttempts: 3 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
`;
const PRESETS = [
    {
        name: 'openspec',
        description: 'explore → propose → apply → test → validate → gate → archive, using the openspec skills',
        summary: 'explore → propose → apply → test → validate → gate → archive',
        yaml: OPENSPEC_YAML,
        requiredSkills: ['openspec-explore', 'openspec-propose', 'openspec-apply-change', 'openspec-archive-change'],
    },
    {
        name: 'spec-kit',
        description: 'specify → plan → implement → test → validate → gate → git-ops, after GitHub Spec Kit',
        summary: 'specify → plan → implement → test → validate → gate → git-ops',
        yaml: SPEC_KIT_YAML,
        requiredSkills: [],
    },
];
export const DEFAULT_PRESET = {
    name: 'default',
    description: 'the standard graph',
    summary: 'discuss → spec → implement → test → validate → review → gate → git-ops',
    yaml: DEFAULT_WORKFLOW_YAML,
    requiredSkills: [],
};
export function getPreset(name) {
    return PRESETS.find((p) => p.name === name);
}
export function presetNames() {
    return PRESETS.map((p) => p.name);
}
export function listPresets() {
    return [...PRESETS];
}
//# sourceMappingURL=presets.js.map