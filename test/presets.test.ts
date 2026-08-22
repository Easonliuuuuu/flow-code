import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../src/defaultWorkflow.js';
import { DEFAULT_PRESET, getPreset, listPresets, presetNames } from '../src/presets.js';
import { defaultSkillRoots, type SkillRoots } from '../src/skills/discover.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';

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
    });
  });

  it('declares how to check for and install the spec-kit CLI', () => {
    expect(getPreset('spec-kit')?.cli).toEqual({
      command: 'specify',
      install: { command: 'uv', args: ['tool', 'install', 'specify-cli'] },
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
      'gate',
      'archive',
    ]);
  });

  it('attaches each openspec skill to the node that needs it', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);

    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });
    const skillsOf = (id: string) => wf.nodes.find((n) => n.id === id)!.skills.map((s) => s.id);

    expect(skillsOf('explore')).toEqual(['openspec-explore']);
    expect(skillsOf('propose')).toEqual(['openspec-propose']);
    expect(skillsOf('apply')).toEqual(['openspec-apply-change']);
    expect(skillsOf('archive')).toEqual(['openspec-archive-change']);
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

  it('gates the git-mutating step, and does not retry a rejected gate', () => {
    const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);

    const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });

    expect(wf.graph.directDependencies('archive')).toEqual(['gate']);
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

  it('is registered with no required skills — there is no canonical Spec Kit skill package', () => {
    expect(presetNames()).toContain('spec-kit');
    expect(preset.requiredSkills).toEqual([]);
  });

  it('loads and validates like any hand-written workflow, with no skill fixtures needed', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.order).toEqual([
      'specify',
      'plan',
      'plan-gate',
      'implement',
      'test',
      'validate',
      'gate',
      'git-ops',
    ]);
  });

  it('puts the only conversational skill on the only interactive node', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    const specify = wf.nodes.find((n) => n.id === 'specify')!;
    expect(specify.type.interactive).toBe(true);
    for (const node of wf.nodes.filter((n) => n.id !== 'specify')) {
      expect(node.type.interactive).toBe(false);
    }
  });

  it('gates the git-mutating step, and does not retry a rejected gate', () => {
    const wf = loadWorkflowFromString(preset.yaml);

    expect(wf.graph.directDependencies('git-ops')).toEqual(['gate']);
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
  });

  it('judges validate against the plan directly, so a retry never rewrites its own contract', () => {
    const wf = loadWorkflowFromString(preset.yaml);

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

describe('every preset', () => {
  it('produces a workflow whose test node still runs explicit commands', () => {
    for (const preset of listPresets()) {
      const { repoRoot, roots } = repoWithPresetSkills(preset.requiredSkills);
      const wf = loadWorkflowFromString(preset.yaml, { repoRoot, skillRoots: roots });
      const test = wf.nodes.find((n) => n.type.id === 'test');
      if (!test) continue;
      expect((test.config as { commands: unknown }).commands).toBeInstanceOf(Array);
    }
  });
});
