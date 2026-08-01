import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/capabilities.js';
import { listNodeTypes, nodeTypeRegistry } from '../src/registry/index.js';
import { loadWorkflowFromString, WorkflowValidationError } from '../src/workflow/load.js';
import { DEFAULT_SETTINGS } from '../src/workflow/schema.js';

const VALID = `
nodes:
  - id: impl
    type: implement
    config:
      instructions: do the thing
  - id: check
    type: test
    config:
      commands: ["echo ok"]
edges:
  - from: impl
    to: check
`;

function problemsOf(yaml: string): string[] {
  try {
    loadWorkflowFromString(yaml);
  } catch (err) {
    if (err instanceof WorkflowValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected workflow to be invalid');
}

describe('workflow loading', () => {
  it('loads a valid workflow and applies documented settings defaults', () => {
    const wf = loadWorkflowFromString(VALID);
    expect(wf.nodes.map((n) => n.id)).toEqual(['impl', 'check']);
    expect(wf.settings).toEqual(DEFAULT_SETTINGS);
    expect(wf.settings.concurrency).toBe(2);
    expect(wf.order).toEqual(['impl', 'check']);
  });

  it('rejects an unknown node type, naming the node id and the type', () => {
    const problems = problemsOf(`
nodes:
  - id: mystery
    type: quantum-leap
`);
    expect(problems.join('\n')).toContain('mystery');
    expect(problems.join('\n')).toContain('quantum-leap');
  });

  it('rejects invalid node config, naming the node id and failing field', () => {
    const problems = problemsOf(`
nodes:
  - id: impl
    type: implement
    config:
      instructions: 42
`);
    expect(problems.join('\n')).toContain('impl');
    expect(problems.join('\n')).toContain('instructions');
  });

  it('rejects an unknown settings key', () => {
    const problems = problemsOf(`
settings:
  concurency: 3
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);
    expect(problems.join('\n')).toContain('settings');
    expect(problems.join('\n')).toMatch(/concurency|Unrecognized/i);
  });

  it('rejects an invalid settings value, naming the setting', () => {
    const problems = problemsOf(`
settings:
  concurrency: 0
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);
    expect(problems.join('\n')).toContain('concurrency');
  });

  it('rejects cycles, identifying the nodes involved', () => {
    const problems = problemsOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: x }
edges:
  - { from: a, to: b }
  - { from: b, to: a }
`);
    expect(problems.join('\n')).toContain('cycle');
    expect(problems.join('\n')).toContain('a');
    expect(problems.join('\n')).toContain('b');
  });

  it('rejects edges referencing unknown nodes, naming the edge', () => {
    const problems = problemsOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
edges:
  - { from: a, to: ghost }
`);
    expect(problems.join('\n')).toContain('a -> ghost');
    expect(problems.join('\n')).toContain('ghost');
  });

  it('rejects unrecognized edge properties, naming the edge', () => {
    const problems = problemsOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: test
    config: { commands: ["true"] }
edges:
  - { from: a, to: b, gate: true }
`);
    expect(problems.join('\n')).toContain('a -> b');
  });

  it('rejects duplicate node ids', () => {
    const problems = problemsOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: a
    type: review
`);
    expect(problems.join('\n')).toContain('duplicate');
  });

  it('requires remote and branch when git-ops push is configured', () => {
    const problems = problemsOf(`
nodes:
  - id: ship
    type: git-ops
    config:
      push:
        remote: origin
`);
    expect(problems.join('\n')).toContain('ship');
    expect(problems.join('\n')).toContain('branch');
  });

  it('accepts commit-only git-ops with no config at all', () => {
    const wf = loadWorkflowFromString(`
nodes:
  - id: ship
    type: git-ops
`);
    expect(wf.nodes[0]!.config).toEqual({});
  });
});

describe('default workflow template', () => {
  it('loads, and gates the git-mutating step behind an Approval-Gate', async () => {
    const { DEFAULT_WORKFLOW_YAML } = await import('../src/defaultWorkflow.js');
    const wf = loadWorkflowFromString(DEFAULT_WORKFLOW_YAML);
    expect(wf.nodes.map((n) => n.type.id)).toEqual([
      'discuss',
      'implement',
      'test',
      'validate',
      'review',
      'approval-gate',
      'git-ops',
    ]);
    const gitOps = wf.nodes.find((n) => n.type.id === 'git-ops')!;
    const gate = wf.nodes.find((n) => n.type.id === 'approval-gate')!;
    // Every path into git-ops passes the gate; the gate follows review.
    expect(wf.graph.directDependencies(gitOps.id)).toEqual([gate.id]);
    expect(wf.graph.ancestorsOf(gate.id)).toContain('review');
    // Default git-ops config: commit-only, no push.
    expect(gitOps.config).toEqual({});
  });
});

describe('node type registry', () => {
  it('registers all eight built-in types', () => {
    expect([...nodeTypeRegistry.keys()].sort()).toEqual(
      [
        'approval-gate',
        'discuss',
        'git-ops',
        'implement',
        'review',
        'test',
        'validate',
        'worktree-agent',
      ].sort(),
    );
  });

  it('declares capabilities only from the closed vocabulary (no network)', () => {
    for (const type of listNodeTypes()) {
      for (const cap of type.capabilities) {
        expect(CAPABILITIES).toContain(cap);
      }
    }
  });

  it('verification types cannot edit', () => {
    for (const id of ['test', 'validate', 'review'] as const) {
      expect(nodeTypeRegistry.get(id)!.capabilities).not.toContain('edit');
    }
  });

  it('only git-ops has git-write', () => {
    for (const type of listNodeTypes()) {
      if (type.id === 'git-ops') expect(type.capabilities).toContain('git-write');
      else expect(type.capabilities).not.toContain('git-write');
    }
  });

  it('git-ops cannot edit', () => {
    expect(nodeTypeRegistry.get('git-ops')!.capabilities).not.toContain('edit');
  });
});
