import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultSkillRoots,
  discoverSkills,
  resolveSkillEntry,
  type SkillRoots,
} from '../../src/skills/discover.js';

function tempTree(): { repoRoot: string; home: string; roots: SkillRoots } {
  const base = mkdtempSync(join(tmpdir(), 'flow-code-skills-test-'));
  const repoRoot = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { repoRoot, home, roots: defaultSkillRoots(repoRoot, home) };
}

/** Writes `<dir>/<name>/SKILL.md`; omit `description` to write no frontmatter. */
function writeSkill(dir: string, name: string, description: string | null, body = 'Do the thing.'): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const front = description === null ? '' : `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
  writeFileSync(join(skillDir, 'SKILL.md'), `${front}${body}\n`);
}

describe('skill discovery', () => {
  it('finds a skill in the project root', () => {
    const { roots } = tempTree();
    writeSkill(roots.project, 'house-review', 'Our review standards.');

    const found = discoverSkills(roots);

    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('house-review');
    expect(found[0]!.description).toBe('Our review standards.');
    expect(found[0]!.source).toBe('project');
    expect(found[0]!.body).toBe('Do the thing.');
  });

  it('finds a skill in the Codex project alternate root', () => {
    const base = mkdtempSync(join(tmpdir(), 'flow-code-codex-skills-test-'));
    const repoRoot = join(base, 'repo');
    const home = join(base, 'home');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    const roots = defaultSkillRoots(repoRoot, home, 'codex');
    const alternate = roots.projectAlternates?.[0];
    expect(alternate).toBeDefined();
    writeSkill(alternate!, 'shared-commit', 'Shared commit workflow.');

    const found = discoverSkills(roots);

    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('shared-commit');
    expect(found[0]!.source).toBe('project');
  });

  it('finds a skill in the user root', () => {
    const { roots } = tempTree();
    writeSkill(roots.user, 'personal', 'My own skill.');

    const found = discoverSkills(roots);

    expect(found.map((s) => [s.id, s.source])).toEqual([['personal', 'user']]);
  });

  it('lets a project skill shadow a user skill of the same name', () => {
    const { roots } = tempTree();
    writeSkill(roots.user, 'review', 'user version', 'user body');
    writeSkill(roots.project, 'review', 'project version', 'project body');

    const found = discoverSkills(roots);

    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe('project');
    expect(found[0]!.body).toBe('project body');
  });

  it('namespaces plugin skills so they never collide with local names', () => {
    const { roots } = tempTree();
    writeSkill(roots.project, 'review', 'local review');
    // <marketplace>/<plugin>/skills/<skill> and <marketplace>/skills/<skill>
    writeSkill(join(roots.plugins, 'market', 'team', 'skills'), 'review', 'plugin review');
    writeSkill(join(roots.plugins, 'flat', 'skills'), 'design', 'flat marketplace skill');

    const found = discoverSkills(roots);

    expect(found.map((s) => s.id).sort()).toEqual(['flat:design', 'review', 'team:review']);
    expect(found.find((s) => s.id === 'review')!.source).toBe('project');
    expect(found.find((s) => s.id === 'team:review')!.source).toBe('plugin');
  });

  it('ignores a directory with no SKILL.md', () => {
    const { roots } = tempTree();
    mkdirSync(join(roots.project, 'not-a-skill'), { recursive: true });
    writeSkill(roots.project, 'real', 'a real one');

    expect(discoverSkills(roots).map((s) => s.id)).toEqual(['real']);
  });

  it('reads a skill with no frontmatter', () => {
    const { roots } = tempTree();
    writeSkill(roots.project, 'bare', null, 'just instructions');

    const found = discoverSkills(roots);

    expect(found[0]!.description).toBe('');
    expect(found[0]!.body).toBe('just instructions');
  });

  it('captures the compatibility field when declared', () => {
    const { roots } = tempTree();
    const dir = join(roots.project, 'needs-cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: needs-cli\ndescription: d\ncompatibility: Requires openspec CLI.\n---\n\nbody\n',
    );

    expect(discoverSkills(roots)[0]!.compatibility).toBe('Requires openspec CLI.');
  });

  it('returns nothing when no root exists', () => {
    const { roots } = tempTree();
    expect(discoverSkills(roots)).toEqual([]);
  });
});

describe('skill entry resolution', () => {
  it('resolves a discovered identifier', () => {
    const { repoRoot, roots } = tempTree();
    writeSkill(roots.project, 'house-review', 'd');

    const { skill } = resolveSkillEntry('house-review', roots, repoRoot);

    expect(skill?.id).toBe('house-review');
    expect(skill?.source).toBe('project');
  });

  it('resolves a namespaced plugin identifier', () => {
    const { repoRoot, roots } = tempTree();
    writeSkill(join(roots.plugins, 'market', 'team', 'skills'), 'review', 'd');

    expect(resolveSkillEntry('team:review', roots, repoRoot).skill?.source).toBe('plugin');
  });

  it('resolves a repo-relative path without consulting the discovery roots', () => {
    const { repoRoot, roots } = tempTree();
    writeSkill(join(repoRoot, 'tools'), 'inline', 'd', 'path body');

    const { skill } = resolveSkillEntry('./tools/inline', roots, repoRoot);

    expect(skill?.source).toBe('path');
    expect(skill?.body).toBe('path body');
  });

  it('reports the roots searched when an identifier resolves to nothing', () => {
    const { repoRoot, roots } = tempTree();

    const { skill, searched } = resolveSkillEntry('missing', roots, repoRoot);

    expect(skill).toBeUndefined();
    expect(searched.join('\n')).toContain(roots.project);
    expect(searched.join('\n')).toContain(roots.user);
    expect(searched.join('\n')).toContain('plugin:missing');
  });

  it('reports the expected file when a path entry resolves to nothing', () => {
    const { repoRoot, roots } = tempTree();

    const { skill, searched } = resolveSkillEntry('./nope', roots, repoRoot);

    expect(skill).toBeUndefined();
    expect(searched[0]).toContain(join('nope', 'SKILL.md'));
  });
});
