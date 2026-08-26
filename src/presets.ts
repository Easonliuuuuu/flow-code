import { DEFAULT_WORKFLOW_YAML } from './defaultWorkflow.js';
import type { CompanionHost } from './guest/host.js';

export interface PresetCommand {
  command: string;
  args: string[];
}

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
  /** Project paths created by the methodology's own initializer. */
  requiredPaths?: string[];
  /** External CLI the preset's skills depend on, if any — checked interactively before scaffolding. */
  cli?: {
    /** Binary name checked on PATH. */
    command: string;
    /** How to install it; shown to the user and run on confirmation. */
    install: PresetCommand;
    /**
     * Command that scaffolds `requiredSkills` into the current project (e.g.
     * `openspec init`), offered when the CLI is available but the skills
     * still aren't. The repo root is appended as the final argument.
     */
    scaffoldSkills?: PresetCommand;
    /** Host-specific initializer arguments, when a methodology writes host skills. */
    scaffoldSkillsByHost?: Partial<Record<CompanionHost, PresetCommand>>;
  };
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

  # Proposal creation is an artifact-writing operation: the real OpenSpec
  # skill runs the CLI and writes proposal/design/spec/task files.
  - id: propose
    type: implement
    config:
      instructions: Create the OpenSpec change and all artifacts needed before implementation, then report the change name and artifact paths.
      skills: [openspec-propose]

  # No config: it reads the proposal from \`propose\`, the node it depends on
  # directly, and needs no pointer to a path.
  - id: propose-gate
    type: approval-gate
    config:
      title: Review the proposal before applying it

  - id: apply
    type: implement
    config:
      instructions: Implement the tasks in the openspec change, including tests covering them.
      skills: [openspec-apply-change]

  # No \`commands\`: this node works out how the project runs its tests on its
  # first execution and asks you to confirm before running anything, then saves
  # the answer here. \`config: { commands: [npm test] }\` skips that.
  - id: test
    type: test

  - id: validate
    type: validate

  # Archive/sync mutates OpenSpec artifacts (mkdir/mv and sometimes spec
  # synchronization), so it needs the same bounded write envelope as Apply.
  # It intentionally runs before the final gate, so the user approves the
  # exact tree Git-ops will commit.
  - id: archive
    type: implement
    config:
      instructions: Sync any approved OpenSpec delta specs and archive the completed change. Report the resulting archive path and any synced specs.
      skills: [openspec-archive-change, openspec-sync-specs]

  - id: gate
    type: approval-gate
    config:
      title: Review the complete change and archived OpenSpec artifacts before committing

  - id: git-ops
    type: git-ops

edges:
  - { from: explore, to: propose }
  - { from: propose, to: propose-gate }
  # Unconditional out of a gate is read as \`when: "propose-gate.decision == 'approved'"\`.
  - { from: propose-gate, to: apply }
  - { from: apply, to: test }
  - { from: test, to: validate }
  # Validate is judged against the proposal's acceptance criteria, so it
  # depends on \`propose\` directly — and that dependency is also what keeps a
  # retry from rewriting the contract it is being judged against.
  - { from: propose, to: validate }
  - { from: validate, to: archive }
  - { from: archive, to: gate }
  # Only the approved final tree reaches Git-ops. A rejected final gate leaves
  # the commit step skipped; start a new run after changing the artifacts.
  - { from: gate, to: git-ops, when: "gate.decision == 'approved'" }

  # Rejecting the proposal reopens the discussion that produced it, rather
  # than ending the run: a proposal is rejected to be rewritten, not
  # abandoned. \`loopback: true\` on a gate's edge means "on rejection" — a
  # rejected gate is reported to the engine as though it had failed,
  # specifically so this one edge can fire on it and only it (see
  # \`defaultWorkflow.ts\` for the full explanation).
  - { from: propose-gate, to: explore, loopback: true }

  - { from: test, to: apply, loopback: { maxAttempts: 3 } }
  - { from: validate, to: apply, loopback: { maxAttempts: 3 } }
`;

const SPEC_KIT_YAML = `# flow-code workflow (spec-kit preset) — checked into your repo, edit as needed.
# Run \`flow-code node-types\` for every node type, and \`flow-code skills\` for
# every skill you can attach to one.
#
# Follows GitHub Spec Kit's specify → plan → tasks → implement lifecycle.
# The official initializer installs these named skills into the selected host's
# project skill root; flow-code requires that setup before opening this preset.

settings:
  concurrency: 1

  budget:
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
      skills: [speckit-specify]

  - id: plan
    type: spec
    config:
      skills: [speckit-plan]

  # No config: it reads the plan from \`plan\`, the node it depends on
  # directly, and needs no pointer to a path.
  - id: plan-gate
    type: approval-gate
    config:
      title: Review the plan before implementation begins

  - id: tasks
    type: implement
    config:
      instructions: Generate the Spec Kit task list from the approved plan before implementation begins.
      skills: [speckit-tasks]

  - id: implement
    type: implement
    config:
      instructions: >-
        Implement the plan above: break it into the tasks needed to satisfy
        every acceptance criterion, including tests covering them.
      skills: [speckit-implement]

  # No \`commands\`: this node works out how the project runs its tests on its
  # first execution and asks you to confirm before running anything, then saves
  # the answer here. \`config: { commands: [npm test] }\` skips that.
  - id: test
    type: test

  - id: validate
    type: validate

  - id: gate
    type: approval-gate
    config:
      title: Review the pending diff before git operations

  # Where a rejected diff goes: an ordinary Discuss node, reached only when
  # \`gate\` is rejected. The gate itself cannot say *why* it was rejected —
  # approve/reject carries no text — so without this the retry knows only that
  # a human said no. Delete it and both conditioned edges below, leaving a bare
  # \`- { from: gate, to: git-ops }\`, to make a rejection end the run instead.
  - id: revise
    type: discuss
    config:
      topic: What has to change about this diff before it can be approved?

  - id: git-ops
    type: git-ops
    # Commits only. To push, add:
    # config:
    #   push: { remote: origin, branch: my-branch }

edges:
  - { from: specify, to: plan }
  - { from: plan, to: plan-gate }
  # Unconditional out of a gate is read as \`when: "plan-gate.decision == 'approved'"\`.
  - { from: plan-gate, to: tasks }
  - { from: tasks, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
  # Validate is judged against the plan's acceptance criteria, so it depends
  # on \`plan\` directly — and that dependency is also what keeps a retry from
  # rewriting the contract it is being judged against.
  - { from: plan, to: validate }
  - { from: validate, to: gate }
  # Both arms spelled out. An unconditional edge out of a gate already means
  # \`when: "gate.decision == 'approved'"\`, but mixing the implicit form with
  # the explicit one beside it reads badly even though it works.
  - { from: gate, to: git-ops, when: "gate.decision == 'approved'" }
  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }

  # Rejecting the plan reopens the discussion that produced it, rather than
  # ending the run: a plan is rejected to be rewritten, not abandoned.
  # \`loopback: true\` on a gate's edge means "on rejection" — a rejected gate
  # is reported to the engine as though it had failed, specifically so this
  # one edge can fire on it and only it (see \`defaultWorkflow.ts\` for the
  # full explanation).
  - { from: plan-gate, to: specify, loopback: true }

  # The way back from a rejected diff. \`on: success\` because finishing the
  # conversation is the signal to go back — a return path waiting for \`revise\`
  # to fail would wait forever. maxAttempts matches the loop-backs below
  # because all three point at \`implement\` and the bound is counted once on
  # the target: a lower number here would starve the revision path first.
  - { from: revise, to: implement, loopback: { maxAttempts: 3, on: success } }

  - { from: test, to: implement, loopback: { maxAttempts: 3 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
`;

const PLANNED_YAML = `# flow-code workflow (planned preset) — checked into your repo, edit as needed.
# Run \`flow-code node-types\` for every node type, and \`flow-code skills\` for
# every skill you can attach to one.
#
# The middle of this graph is negotiated at run time, not written here: the
# \`plan\` node talks with you about what's being built, proposes a graph of
# ordinary node types to build it, and does not complete until you accept
# one. What it proposes is spliced in between \`plan\` and \`gate\` below — this
# file only has to carry the part that never changes: the gate every
# git-writing node must be dominated by, and the git-ops step behind it.
#
# After a run, you'll be offered the chance to keep the graph it negotiated —
# accepting replaces this file with the expanded, ordinary one, and the next
# run skips planning entirely.

nodes:
  - id: plan
    type: plan

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
  - { from: plan, to: gate }
  - { from: gate, to: git-ops }
`;

const FRUGAL_YAML = `# flow-code workflow (frugal preset) — checked into your repo, edit as needed.
# Run \`flow-code node-types\` for every node type, and \`flow-code skills\` for
# every skill you can attach to one.
#
# The default graph spends 6 agent sessions on a change. This one spends 5 and
# bounds each of them, for when the structure is worth having but the bill is
# not. Three deliberate differences from the default, all of them reversible:
#
#   1. No Review node. Validate already judges the diff against the spec's
#      acceptance criteria one by one; Review is a second, broader read of the
#      same diff. Dropping it removes a whole agent session and the context it
#      re-reads. Put it back when the change is risky enough to want two
#      opinions — that is exactly the trade being made here.
#   2. \`subagents: false\`. Delegation is where a session's token count runs
#      away: each subagent re-establishes its own context, and every one of
#      them counts against the run's budget. Turning it off makes a run's cost
#      roughly predictable from its node count.
#   3. Ceilings sized for one change, not one afternoon, and one fewer retry.
#
# What is *not* traded away: both approval gates, the loop-back on a failing
# test, and the exit-code verdict. Frugal means fewer and smaller sessions, not
# less of a say in what reaches git.
#
# The other big lever is per-node models — a cheap model for the steps that
# summarize and check, the capable one only for the step that writes code. It
# is left commented out rather than filled in because model names are
# provider-specific and a wrong one fails the run: uncomment the \`model:\`
# lines below and put in names your provider actually serves. \`m\` on a focused
# node sets one mid-run without editing this file.

settings:
  concurrency: 1

  # Off by default here — see (2) above.
  subagents: false

  # Cache reads are excluded from these totals (they are billed at a fraction
  # of base input and grow with how long a node has run rather than how much
  # work it did). Fresh input, output and cache *writes* all count.
  budget:
    tokensPerNode: 250000
    tokensPerRun: 600000
    minutesPerRun: 30

nodes:
  - id: discuss
    type: discuss
    config:
      topic: What should this change accomplish?
      # A cheap model is usually enough to hold this conversation:
      # model: <a small model your provider serves>

  - id: spec
    type: spec
    # Summarizing a conversation into acceptance criteria is the cheapest kind
    # of work in the graph.
    # config:
    #   model: <a small model your provider serves>

  - id: spec-gate
    type: approval-gate
    config:
      title: Review the spec before implementation begins

  - id: implement
    type: implement
    config:
      instructions: Implement what the upstream spec requires, including tests covering it.
      # The one step worth paying for. If you set a model anywhere, set it here:
      # model: <your most capable model>

  # No \`commands\`: this node works out how the project runs its tests on its
  # first execution and asks you to confirm before running anything, then saves
  # the answer here. \`config: { commands: [npm test] }\` skips that. No agent
  # session either way — the verdict is an exit code.
  - id: test
    type: test

  - id: validate
    type: validate
    # Checking a diff against criteria that are already written down is
    # mechanical enough for a small model.
    # config:
    #   model: <a small model your provider serves>

  - id: gate
    type: approval-gate
    config:
      title: Review the pending diff before git operations

  # Reached only when \`gate\` is rejected, so it costs nothing on a run you
  # approve. It carries the *why* back to \`implement\`, which a gate cannot:
  # approve/reject has no text on it. Delete this node and both conditioned
  # edges below, leaving a bare \`- { from: gate, to: git-ops }\`, to make a
  # rejection end the run instead.
  - id: revise
    type: discuss
    config:
      topic: What has to change about this diff before it can be approved?

  - id: git-ops
    type: git-ops
    # Commits only. To push, add:
    # config:
    #   push: { remote: origin, branch: my-branch }

edges:
  - { from: discuss, to: spec }
  - { from: spec, to: spec-gate }
  # Unconditional out of a gate is read as \`when: "spec-gate.decision == 'approved'"\`.
  - { from: spec-gate, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
  # Validate is judged against the spec directly, which is also what keeps a
  # retry from rewriting the contract it is being judged against.
  - { from: spec, to: validate }
  # Straight to the gate: with no Review node, Validate's verdict is the last
  # automated word before a human's.
  - { from: validate, to: gate }
  - { from: gate, to: git-ops, when: "gate.decision == 'approved'" }
  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }

  # A rejected spec reopens the discussion that produced it rather than ending
  # the run. \`loopback: true\` on a gate's edge means "on rejection".
  - { from: spec-gate, to: discuss, loopback: true }

  # \`on: success\` because finishing the conversation is the signal to go back —
  # a return path waiting for \`revise\` to fail would wait forever. maxAttempts
  # matches the loop-backs below because all three point at \`implement\` and the
  # bound is counted once on the target.
  - { from: revise, to: implement, loopback: { maxAttempts: 2, on: success } }

  # Two attempts rather than three. A third pass at a change that has already
  # failed twice is usually the most expensive way to learn it needs a human.
  - { from: test, to: implement, loopback: { maxAttempts: 2 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 2 } }
`;

const PRESETS: WorkflowPreset[] = [
  {
    name: 'openspec',
    description: 'explore → propose → gate → apply → test → validate → archive → gate → git-ops, using the openspec skills',
    summary: 'explore → propose → gate → apply → test → validate → archive → gate → git-ops',
    yaml: OPENSPEC_YAML,
    requiredSkills: [
      'openspec-explore',
      'openspec-propose',
      'openspec-apply-change',
      'openspec-archive-change',
      'openspec-sync-specs',
    ],
    requiredPaths: ['openspec/changes', 'openspec/archive', 'openspec/specs'],
    cli: {
      command: 'openspec',
      install: { command: 'npm', args: ['install', '-g', '@fission-ai/openspec@latest'] },
      scaffoldSkills: { command: 'openspec', args: ['init', '--tools', 'claude'] },
      scaffoldSkillsByHost: {
        codex: { command: 'openspec', args: ['init', '--tools', 'codex'] },
      },
    },
  },
  {
    name: 'spec-kit',
    description: 'specify → plan → gate → tasks → implement → test → validate → gate → git-ops, after GitHub Spec Kit',
    summary: 'specify → plan → gate → tasks → implement → test → validate → gate → git-ops',
    yaml: SPEC_KIT_YAML,
    requiredSkills: ['speckit-specify', 'speckit-plan', 'speckit-tasks', 'speckit-implement'],
    requiredPaths: ['.specify'],
    cli: {
      command: 'specify',
      install: { command: 'uv', args: ['tool', 'install', 'specify-cli'] },
      scaffoldSkills: {
        command: 'specify',
        args: ['init', '--here', '--integration', 'claude'],
      },
      scaffoldSkillsByHost: {
        codex: {
          command: 'specify',
          args: ['init', '--here', '--integration', 'codex', '--integration-options=--skills'],
        },
      },
    },
  },
  {
    name: 'frugal',
    description:
      'the default graph with the expensive parts removed — no Review node, no subagents, tighter ceilings',
    summary: 'discuss → spec → gate → implement → test → validate → gate → git-ops',
    yaml: FRUGAL_YAML,
    requiredSkills: [],
  },
  {
    name: 'planned',
    description: 'plan → gate → git-ops — the graph in between is negotiated with you at run time',
    summary: 'plan → gate → git-ops',
    yaml: PLANNED_YAML,
    requiredSkills: [],
  },
];

export const DEFAULT_PRESET: WorkflowPreset = {
  name: 'default',
  description: 'the standard graph',
  summary: 'discuss → spec → gate → implement → test → validate → review → gate → git-ops',
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

/** The initializer that matches the companion host, falling back to the preset default. */
export function presetScaffoldCommand(
  preset: WorkflowPreset,
  host?: CompanionHost,
): PresetCommand | undefined {
  return (host !== undefined ? preset.cli?.scaffoldSkillsByHost?.[host] : undefined) ?? preset.cli?.scaffoldSkills;
}

/**
 * The command that installs `skillId`, when it is a skill some preset ships
 * with — otherwise undefined, because a skill flow-code did not scaffold is
 * one it has no standing to suggest an installer for.
 *
 * Keyed on the skill name rather than on which preset a file came from: a
 * scaffolded `workflow.yaml` records no provenance, and by the time a skill
 * fails to resolve the only thing known about it is its name. The trailing
 * `.` matches `scaffoldSkills`' contract of taking the target directory last.
 */
export function skillScaffoldCommand(skillId: string, host?: CompanionHost): string | undefined {
  for (const preset of PRESETS) {
    const scaffold = presetScaffoldCommand(preset, host);
    if (!scaffold || !preset.requiredSkills.includes(skillId)) continue;
    return [scaffold.command, ...scaffold.args, '.'].join(' ');
  }
  return undefined;
}
