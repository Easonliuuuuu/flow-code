import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../src/defaultWorkflow.js';
import { DEFAULT_PRESET, getPreset, listPresets, presetNames } from '../src/presets.js';
import { defaultSkillRoots, type SkillRoots } from '../src/skills/discover.js';
import { loadWorkflowFromString, WorkflowValidationError } from '../src/workflow/load.js';
import { makeTempGitRepo } from './helpers.js';

/** A fixture tree with every skill the openspec preset references. */
function repoWithPresetSkills(names: string[]): { repoRoot: string; roots: SkillRoots } {
  const base = mkdtempSync(join(tmpdir(), 'flow-code-preset-'));
  const repoRoot = join(base, 'repo');
  const roots = defaultSkillRoots(repoRoot, join(base, 'home'));
  for (const name of names) {
    const dir = join(roots.project, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${name} body\n`);
  }
  for (const path of ['openspec/changes', 'openspec/archive', 'openspec/specs', '.specify']) {
    mkdirSync(join(repoRoot, path), { recursive: true });
  }
  return { repoRoot, roots };
}

describe('preset registry', () => {
  it('exposes the openspec preset by name', () => {
    expect(presetNames()).toContain('openspec');
    expect(getPreset('openspec')?.summary).toContain('explore');
  });

  it('declares how to check for and install the openspec CLI, and how to scaffold its skills', () => {
    expect(getPreset('openspec')?.cli).toEqual({
      command: 'openspec',
      install: { command: 'npm', args: ['install', '-g', '@fission-ai/openspec@latest'] },
      scaffoldSkills: { command: 'openspec', args: ['init', '--tools', 'claude'] },
      scaffoldSkillsByHost: {
        codex: { command: 'openspec', args: ['init', '--tools', 'codex'] },
      },
    });
  });

  it('requires an initialized OpenSpec project structure', () => {
    expect(getPreset('openspec')?.requiredPaths).toEqual([
      'openspec/changes',
      'openspec/archive',
      'openspec/specs',
    ]);
  });

  it('declares how to check, install, and initialize the spec-kit CLI', () => {
    expect(getPreset('spec-kit')?.cli).toEqual({
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
    });
  });

  it('has no CLI dependency for the default preset', () => {
    expect(DEFAULT_PRESET.cli).toBeUndefined();
  });

  it('returns nothing for an unknown name', () => {
    expect(getPreset('nope')).toBeUndefined();
  });

  it('exposes the planned preset by name, with no skills and no CLI dependency', () => {
    expect(presetNames()).toContain('planned');
    const preset = getPreset('planned')!;
    expect(preset.summary).toBe('plan → gate → git-ops');
    expect(preset.requiredSkills).toEqual([]);
    expect(preset.cli).toBeUndefined();
  });

  it('keeps the default preset as the untouched default graph', () => {
    expect(DEFAULT_PRESET.yaml).toBe(DEFAULT_WORKFLOW_YAML);
    expect(DEFAULT_PRESET.requiredSkills).toEqual([]);
  });
});

describe('the openspec preset scaffolds a valid workflow', () => {
  const preset = getPreset('openspec')!;

  it('loads and validates like any hand-written workflow', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);

    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    expect(wf.order).toEqual([
      'explore',
      'propose',
      'propose-gate',
      'apply',
      'test',
      'validate',
      'archive',
      'gate',
      'git-ops',
    ]);
  });

  it('attaches each openspec skill to the node that needs it', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);

    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });
    const skillsOf = (id: string) => wf.nodes.find((n) => n.id === id)!.skills.map((s) => s.id);

    expect(skillsOf('explore')).toEqual(['openspec-explore']);
    expect(skillsOf('propose')).toEqual(['openspec-propose']);
    expect(skillsOf('apply')).toEqual(['openspec-apply-change']);
    expect(skillsOf('archive')).toEqual(['openspec-archive-change', 'openspec-sync-specs']);
  });

  it('puts the only conversational skill on the only interactive node', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);

    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    const explore = wf.nodes.find((n) => n.id === 'explore')!;
    expect(explore.type.interactive).toBe(true);
    for (const node of wf.nodes.filter((n) => n.id !== 'explore')) {
      expect(node.type.interactive).toBe(false);
    }
  });

  it('runs archive before the final gate and gates the git-mutating step', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);

    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    expect(wf.nodes.find((n) => n.id === 'archive')!.type.id).toBe('implement');
    expect(wf.graph.directDependencies('gate')).toEqual(['archive']);
    expect(wf.graph.directDependencies('git-ops')).toEqual(['gate']);
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
  });

  it('fails to load when its skills are not installed, naming them', () => {
    const { repoRoot, roots } = repoWithPresetSkills([]);

    expect(() => loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots })).toThrow(
      /openspec-explore/,
    );
  });

  it('declares every skill its yaml references', () => {
    const referenced = [...preset.yaml.matchAll(/skills: \[([^\]]+)\]/g)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim()),
    );

    expect([...new Set(referenced)].sort()).toEqual([...preset.requiredSkills].sort());
  });
});

describe('the spec-kit preset scaffolds a valid workflow', () => {
  const preset = getPreset('spec-kit')!;

  it('requires the official Spec Kit skills and project marker', () => {
    expect(presetNames()).toContain('spec-kit');
    expect(preset.requiredSkills).toEqual([
      'speckit-specify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-implement',
    ]);
    expect(preset.requiredPaths).toEqual(['.specify']);
  });

  it('loads and validates like any hand-written workflow after Spec Kit initialization', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);
    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    expect(wf.order).toEqual([
      'specify',
      'plan',
      'plan-gate',
      'tasks',
      'implement',
      'test',
      'validate',
      'gate',
      'git-ops',
      'revise',
    ]);
  });

  it('puts the only conversational skill on the only interactive node', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);
    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    const specify = wf.nodes.find((n) => n.id === 'specify')!;
    expect(specify.type.interactive).toBe(true);
    // `revise` is the second interactive node, by design: a rejected diff is
    // routed into a conversation so the retry knows what to change.
    expect(wf.nodes.find((n) => n.id === 'revise')!.type.interactive).toBe(true);
    for (const node of wf.nodes.filter((n) => n.id !== 'specify' && n.id !== 'revise')) {
      expect(node.type.interactive).toBe(false);
    }
  });

  it('gates the git-mutating step, and does not retry a rejected gate', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);
    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    expect(wf.graph.directDependencies('git-ops')).toEqual(['gate']);
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
  });

  it('judges validate against the plan directly, so a retry never rewrites its own contract', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);
    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    expect(wf.graph.directDependencies('validate').sort()).toEqual(['plan', 'test']);
  });
});

describe('the planned preset scaffolds a valid workflow', () => {
  const preset = getPreset('planned')!;

  it('loads and validates like any hand-written workflow, with no skill fixtures needed', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.order).toEqual(['plan', 'gate', 'git-ops']);
  });

  it('is exactly the spine — a Plan node, at the root, with nothing to negotiate away yet', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    const plan = wf.nodes.find((n) => n.id === 'plan')!;
    expect(plan.type.id).toBe('plan');
    expect(wf.graph.directDependencies('plan')).toEqual([]);
    expect(plan.type.interactive).toBe(true);
    for (const node of wf.nodes.filter((n) => n.id !== 'plan')) {
      expect(node.type.interactive).toBe(false);
    }
  });

  it('gates the git-mutating step, and does not retry a rejected gate', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.graph.directDependencies('git-ops')).toEqual(['gate']);
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
  });
});

describe('the frugal preset scaffolds a valid workflow', () => {
  const preset = getPreset('frugal')!;

  it('loads and validates like any hand-written workflow, with no skill fixtures needed', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.order).toEqual([
      'discuss',
      'spec',
      'spec-gate',
      'implement',
      'test',
      'validate',
      'gate',
      'git-ops',
      'revise',
    ]);
  });

  it('is the default graph minus its second opinion — no Review node', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.nodes.some((n) => n.type.id === 'review')).toBe(false);
    // Validate's verdict is the last automated word before a human's.
    expect(wf.graph.directDependencies('gate')).toEqual(['validate']);
  });

  it('turns delegation off, since a subagent is where a session\'s cost runs away', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.settings.subagents).toBe(false);
    expect(wf.settings.concurrency).toBe(1);
  });

  it('bounds the run in every dimension a budget has', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.settings.budget).toEqual({
      tokensPerNode: 250000,
      tokensPerRun: 600000,
      minutesPerRun: 30,
    });
  });

  it('spends one fewer retry than the default on every path back to implement', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    const loopbacks = wf.graph.allLoopbacks().filter((l) => l.to === 'implement');
    expect(loopbacks.length).toBe(3);
    for (const loopback of loopbacks) {
      expect(loopback.maxAttempts).toBe(2);
    }
  });

  it('keeps both gates — frugal is about fewer sessions, not less of a say', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.nodes.filter((n) => n.type.id === 'approval-gate').map((n) => n.id)).toEqual([
      'spec-gate',
      'gate',
    ]);
    expect(wf.graph.directDependencies('git-ops')).toEqual(['gate']);
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
  });

  it('names no model, so it cannot scaffold one the configured provider will not serve', () => {
    for (const node of loadWorkflowFromString(preset.yaml).nodes) {
      expect((node.config as { model?: unknown }).model).toBeUndefined();
    }
  });
});

describe('a preset skill that is not installed names its installer', () => {
  const preset = getPreset('openspec')!;

  it('says which command scaffolds it, on the load error every surface shows', () => {
    // Deliberately a bare repo with no skills: this is what a companion-mode
    // user meets, and `flow-code connect` never runs the `init` path that
    // used to be the only place the remedy was named.
    const repoRoot = makeTempGitRepo();

    let problems: string[] = [];
    try {
      loadWorkflowFromString(preset.yaml, { repoRoot });
      throw new Error('expected the preset to fail to load without its skills');
    } catch (err) {
      problems = (err as WorkflowValidationError).problems;
    }

    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem).toContain('openspec init --tools claude .');
    }
  });

  it('suggests nothing for a skill no preset ships', () => {
    const repoRoot = makeTempGitRepo();
    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x, skills: [not-a-preset-skill] }
`;

    let problems: string[] = [];
    try {
      loadWorkflowFromString(yaml, { repoRoot });
      throw new Error('expected an unresolvable skill to fail the load');
    } catch (err) {
      problems = (err as WorkflowValidationError).problems;
    }

    // flow-code has no standing to recommend an installer for a skill it does
    // not ship, and a wrong guess is worse than none.
    expect(problems[0]).toContain('not-a-preset-skill');
    expect(problems[0]).not.toContain('Run `');
  });
});

describe('every preset', () => {
  it('leaves every test node to work its own commands out and confirm them', () => {
    for (const preset of listPresets()) {
      const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);
      const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });
      const test = wf.nodes.find((n) => n.type.id === 'test');
      if (!test) continue;
      // Not `auto`: that rediscovers on every execution and never persists,
      // which the loader rejects alongside the retry loops these presets ship.
      expect((test.config as { commands?: unknown }).commands).toBeUndefined();
    }
  });
});
