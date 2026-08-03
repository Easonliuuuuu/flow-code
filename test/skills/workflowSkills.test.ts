import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listNodeTypes } from '../../src/registry/index.js';
import { defaultSkillRoots, type SkillRoots } from '../../src/skills/discover.js';
import { loadWorkflowFromString, WorkflowValidationError } from '../../src/workflow/load.js';

function fixture(skills: Record<string, string> = {}): { repoRoot: string; roots: SkillRoots } {
  const base = mkdtempSync(join(tmpdir(), 'flow-code-wf-skills-'));
  const repoRoot = join(base, 'repo');
  const roots = defaultSkillRoots(repoRoot, join(base, 'home'));
  for (const [name, body] of Object.entries(skills)) {
    const dir = join(roots.project, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
  }
  return { repoRoot, roots };
}

function load(yaml: string, skills: Record<string, string> = {}) {
  const { repoRoot, roots } = fixture(skills);
  return loadWorkflowFromString(yaml, { repoRoot, skillRoots: roots });
}

function problemsOf(yaml: string, skills: Record<string, string> = {}): string[] {
  try {
    load(yaml, skills);
  } catch (err) {
    if (err instanceof WorkflowValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected workflow to be invalid');
}

describe('skills on nodes', () => {
  it('attaches resolved skills to the right node, in declaration order', () => {
    const wf = load(
      `
nodes:
  - id: review
    type: review
    config:
      skills: [second, first]
  - id: impl
    type: implement
    config:
      instructions: do it
edges: []
`,
      { first: 'first body', second: 'second body' },
    );

    const review = wf.nodes.find((n) => n.id === 'review')!;
    expect(review.skills.map((s) => s.id)).toEqual(['second', 'first']);
    expect(review.skills.map((s) => s.body)).toEqual(['second body', 'first body']);
    expect(wf.nodes.find((n) => n.id === 'impl')!.skills).toEqual([]);
  });

  it('rejects an unresolvable skill, naming the node, the entry, and the roots searched', () => {
    const problems = problemsOf(`
nodes:
  - id: review
    type: review
    config:
      skills: [nope]
edges: []
`);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('node `review` (review)');
    expect(problems[0]).toContain('no skill `nope`');
    expect(problems[0]).toContain('.claude/skills');
    expect(problems[0]).toContain('plugin:nope');
  });

  it('rejects skills on a Test node', () => {
    const problems = problemsOf(`
nodes:
  - id: check
    type: test
    config:
      commands: ["echo ok"]
      skills: [anything]
edges: []
`);

    expect(problems.join('\n')).toContain('node `check` (test) config');
    expect(problems.join('\n')).toMatch(/skills/);
  });

  it('rejects skills on an Approval-Gate node', () => {
    const problems = problemsOf(`
nodes:
  - id: gate
    type: approval-gate
    config:
      skills: [anything]
edges: []
`);

    expect(problems.join('\n')).toContain('node `gate` (approval-gate) config');
  });

  it('does not scan the discovery roots when no node names a skill', () => {
    // A missing project root would throw if discovery ran eagerly over it.
    const wf = loadWorkflowFromString(
      `
nodes:
  - id: impl
    type: implement
    config:
      instructions: do it
edges: []
`,
      { repoRoot: '/nonexistent', skillRoots: defaultSkillRoots('/nonexistent', '/nonexistent') },
    );

    expect(wf.nodes[0]!.skills).toEqual([]);
  });
});

describe('node type interactivity', () => {
  it('marks Discuss interactive and nothing else', () => {
    const interactive = listNodeTypes()
      .filter((t) => t.interactive)
      .map((t) => t.id);

    expect(interactive).toEqual(['discuss']);
  });

  it('gives every non-agent-driven type interactive: false', () => {
    for (const type of listNodeTypes().filter((t) => !t.agentDriven)) {
      expect(type.interactive).toBe(false);
    }
  });
});

describe('test commands: auto', () => {
  const AUTO_WITH_LOOPBACK = `
nodes:
  - id: impl
    type: implement
    config:
      instructions: do it
  - id: check
    type: test
    config:
      commands: auto
edges:
  - { from: impl, to: check }
  - { from: check, to: impl, loopback: true }
`;

  it('accepts auto when no loop-back can re-run the node', () => {
    const wf = load(`
nodes:
  - id: impl
    type: implement
    config:
      instructions: do it
  - id: check
    type: test
    config:
      commands: auto
edges:
  - { from: impl, to: check }
`);

    expect((wf.nodes.find((n) => n.id === 'check')!.config as { commands: string }).commands).toBe(
      'auto',
    );
  });

  it('rejects auto combined with a loop-back that re-runs the node', () => {
    const problems = problemsOf(AUTO_WITH_LOOPBACK);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('node `check` (test)');
    expect(problems[0]).toContain('cannot be combined with retry');
  });

  it('rejects auto when a loop-back further downstream re-runs it indirectly', () => {
    const problems = problemsOf(`
nodes:
  - id: impl
    type: implement
    config:
      instructions: do it
  - id: check
    type: test
    config:
      commands: auto
  - id: verify
    type: validate
edges:
  - { from: impl, to: check }
  - { from: check, to: verify }
  - { from: verify, to: impl, loopback: true }
`);

    expect(problems[0]).toContain('node `check` (test)');
  });

  it('still accepts an explicit command list under a loop-back', () => {
    const wf = load(`
nodes:
  - id: impl
    type: implement
    config:
      instructions: do it
  - id: check
    type: test
    config:
      commands: ["npm test"]
edges:
  - { from: impl, to: check }
  - { from: check, to: impl, loopback: true }
`);

    expect(
      (wf.nodes.find((n) => n.id === 'check')!.config as { commands: string[] }).commands,
    ).toEqual(['npm test']);
  });

  it('rejects an empty command list', () => {
    const problems = problemsOf(`
nodes:
  - id: check
    type: test
    config:
      commands: []
edges: []
`);

    expect(problems.join('\n')).toContain('node `check` (test) config');
  });
});
