import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflight } from '../../src/engine/preflight.js';
import { defaultSkillRoots, type DiscoveredSkill, type SkillRoots } from '../../src/skills/discover.js';
import {
  formatSkillsListing,
  skillCompatibilityNotes,
  skillPortabilityWarnings,
} from '../../src/skills/report.js';
import { loadWorkflowFromString } from '../../src/workflow/load.js';
import { makeTempGitRepo } from '../helpers.js';

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'house',
    description: 'House rules.',
    source: 'project',
    path: '/repo/.claude/skills/house/SKILL.md',
    body: 'b',
    ...overrides,
  };
}

describe('formatSkillsListing', () => {
  it('says where it looked when nothing is found', () => {
    const lines = formatSkillsListing([], '/repo').join('\n');

    expect(lines).toContain('no skills found');
    expect(lines).toContain('.claude/skills/');
  });

  it('prints identifier, source, description, and a repo-relative path', () => {
    const lines = formatSkillsListing([skill()], '/repo').join('\n');

    expect(lines).toContain('house  (project)');
    expect(lines).toContain('House rules.');
    expect(lines).toContain('.claude/skills/house/SKILL.md');
    expect(lines).not.toContain('not in this repo');
  });

  it('flags a non-portable skill and shows its absolute path', () => {
    const lines = formatSkillsListing(
      [skill({ id: 'mine', source: 'user', path: '/home/me/.claude/skills/mine/SKILL.md' })],
      '/repo',
    ).join('\n');

    expect(lines).toContain('mine  (user)');
    expect(lines).toContain('/home/me/.claude/skills/mine/SKILL.md');
    expect(lines).toContain('not in this repo');
  });

  it('surfaces a declared compatibility requirement', () => {
    const lines = formatSkillsListing([skill({ compatibility: 'Requires openspec CLI.' })], '/repo');

    expect(lines.join('\n')).toContain('requires: Requires openspec CLI.');
  });
});

describe('skillCompatibilityNotes', () => {
  it('reports only the skills that declare a dependency', () => {
    const notes = skillCompatibilityNotes([
      skill({ id: 'a' }),
      skill({ id: 'b', compatibility: 'Requires foo.' }),
    ]);

    expect(notes).toEqual(['  b: Requires foo.']);
  });
});

function fixtureWith(root: 'project' | 'user'): { repoRoot: string; roots: SkillRoots } {
  const base = mkdtempSync(join(tmpdir(), 'flow-code-report-'));
  const repoRoot = join(base, 'repo');
  const roots = defaultSkillRoots(repoRoot, join(base, 'home'));
  const dir = join(roots[root], 'house');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: house\ndescription: d\n---\n\nbody\n');
  return { repoRoot, roots };
}

const YAML = `
nodes:
  - id: review
    type: review
    config:
      skills: [house]
edges: []
`;

describe('skillPortabilityWarnings', () => {
  it('warns about a skill resolved from the user root', () => {
    const { repoRoot, roots } = fixtureWith('user');
    const wf = loadWorkflowFromString(YAML, { repoRoot, skillRoots: roots });

    const warnings = skillPortabilityWarnings(wf);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('node `review`');
    expect(warnings[0]).toContain('`house`');
    expect(warnings[0]).toContain('not part of this repo');
  });

  it('is silent when every skill is project-local', () => {
    const { repoRoot, roots } = fixtureWith('project');
    const wf = loadWorkflowFromString(YAML, { repoRoot, skillRoots: roots });

    expect(skillPortabilityWarnings(wf)).toEqual([]);
  });
});

describe('preflight reports portability without failing', () => {
  it('emits the warning and still completes', async () => {
    const { roots } = fixtureWith('user');
    const gitRepo = makeTempGitRepo();
    const wf = loadWorkflowFromString(YAML, { repoRoot: gitRepo, skillRoots: roots });
    const warnings: string[] = [];

    await preflight(wf, gitRepo, {
      allowDirty: true,
      credentialsResolver: () => true,
      onWarning: (m) => warnings.push(m),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('will not load on another checkout');
  });

  it('emits nothing for a project-local skill', async () => {
    const { roots } = fixtureWith('project');
    const gitRepo = makeTempGitRepo();
    const wf = loadWorkflowFromString(YAML, { repoRoot: gitRepo, skillRoots: roots });
    const warnings: string[] = [];

    await preflight(wf, gitRepo, {
      allowDirty: true,
      credentialsResolver: () => true,
      onWarning: (m) => warnings.push(m),
    });

    expect(warnings).toEqual([]);
  });
});
