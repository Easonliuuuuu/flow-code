import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPreset } from '../src/presets.js';
import { defaultSkillRoots, type SkillRoots } from '../src/skills/discover.js';
import { selectWorkflow } from '../src/workflow/select.js';

function repoWithSkills(names: string[], initialized = true): { repo: string; roots: SkillRoots } {
  const base = mkdtempSync(join(tmpdir(), 'flow-code-select-'));
  const repo = join(base, 'repo');
  const roots = defaultSkillRoots(repo, join(base, 'home'));
  for (const name of names) {
    const dir = join(roots.project, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  }
  if (initialized) {
    for (const path of ['openspec/changes', 'openspec/archive', 'openspec/specs']) {
      mkdirSync(join(repo, path), { recursive: true });
    }
  }
  return { repo, roots };
}

describe('runtime workflow selection', () => {
  it('loads the canonical OpenSpec graph and leaves the project workflow untouched', async () => {
    const preset = getPreset('openspec')!;
    const { repo, roots } = repoWithSkills(preset.requiredSkills);
    const projectWorkflow = join(repo, '.flow-code', 'workflow.yaml');
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(projectWorkflow, 'project workflow\n');

    const selected = await selectWorkflow(repo, { preset: 'openspec' }, {
      skillRoots: roots,
      isCliAvailable: async () => true,
    });

    expect(selected.preset?.name).toBe('openspec');
    expect(selected.workflow.order).toEqual([
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
    expect(readFileSync(projectWorkflow, 'utf8')).toBe('project workflow\n');
  });

  it('refuses a preset when its skills are missing', async () => {
    const { repo, roots } = repoWithSkills([]);

    await expect(
      selectWorkflow(repo, { preset: 'openspec' }, {
        skillRoots: roots,
        isCliAvailable: async () => true,
      }),
    ).rejects.toThrow(/openspec-explore/);
  });

  it('refuses a preset when its CLI is missing', async () => {
    const preset = getPreset('openspec')!;
    const { repo, roots } = repoWithSkills(preset.requiredSkills);

    await expect(
      selectWorkflow(repo, { preset: 'openspec' }, {
        skillRoots: roots,
        isCliAvailable: async () => false,
      }),
    ).rejects.toThrow(/openspec.*CLI/);
  });

  it('refuses OpenSpec when the project has not been initialized', async () => {
    const preset = getPreset('openspec')!;
    const { repo, roots } = repoWithSkills(preset.requiredSkills, false);

    await expect(
      selectWorkflow(repo, { preset: 'openspec' }, {
        skillRoots: roots,
        isCliAvailable: async () => true,
      }),
    ).rejects.toThrow(/not initialized.*openspec\/changes/);
  });

  it('discovers OpenSpec skills in Codex roots when the Codex host is selected', async () => {
    const base = mkdtempSync(join(tmpdir(), 'flow-code-codex-select-'));
    const repo = join(base, 'repo');
    const roots = defaultSkillRoots(repo, join(base, 'home'), 'codex');
    for (const name of getPreset('openspec')!.requiredSkills) {
      const dir = join(roots.project, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
    }
    for (const path of ['openspec/changes', 'openspec/archive', 'openspec/specs']) {
      mkdirSync(join(repo, path), { recursive: true });
    }

    const selected = await selectWorkflow(repo, { preset: 'openspec', host: 'codex' }, {
      skillRoots: roots,
      isCliAvailable: async () => true,
    });

    expect(selected.preset?.name).toBe('openspec');
  });

  it('does not allow a project graph and preset at the same time', async () => {
    const { repo } = repoWithSkills([]);

    await expect(selectWorkflow(repo, { graph: 'main', preset: 'openspec' })).rejects.toThrow(
      /cannot be selected together/,
    );
  });
});
