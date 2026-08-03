import { DEFAULT_WORKFLOW_YAML } from './defaultWorkflow.js';

/**
 * A named starting workflow. A preset is a scaffolded file and nothing more —
 * it composes existing node types with skills, and adds no registry surface.
 * That is the whole reason methodologies like openspec ship as presets rather
 * than as four new node types: explore/propose/apply/archive are not new
 * *kinds* of node, they are Discuss/Spec/Implement/Git-ops given different
 * instructions.
 */
export interface WorkflowPreset {
  name: string;
  description: string;
  /** Graph summary printed after scaffolding. */
  summary: string;
  yaml: string;
  /** Skills the scaffolded graph references, checked after writing. */
  requiredSkills: string[];
}

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
        - echo "replace me with your project's test command"

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

const PRESETS: WorkflowPreset[] = [
  {
    name: 'openspec',
    description: 'explore → propose → apply → test → validate → gate → archive, using the openspec skills',
    summary: 'explore → propose → apply → test → validate → gate → archive',
    yaml: OPENSPEC_YAML,
    requiredSkills: ['openspec-explore', 'openspec-propose', 'openspec-apply-change', 'openspec-archive-change'],
  },
];

export const DEFAULT_PRESET: WorkflowPreset = {
  name: 'default',
  description: 'the standard graph',
  summary: 'discuss → spec → implement → test → validate → review → gate → git-ops',
  yaml: DEFAULT_WORKFLOW_YAML,
  requiredSkills: [],
};

export function getPreset(name: string): WorkflowPreset | undefined {
  return PRESETS.find((p) => p.name === name);
}

export function presetNames(): string[] {
  return PRESETS.map((p) => p.name);
}

export function listPresets(): WorkflowPreset[] {
  return [...PRESETS];
}
