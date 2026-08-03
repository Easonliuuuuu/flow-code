import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/capabilities.js';
import { listNodeTypes, nodeTypeRegistry } from '../src/registry/index.js';
import { loadWorkflowFromString, WorkflowValidationError } from '../src/workflow/load.js';
import { DEFAULT_LOOPBACK_MAX_ATTEMPTS, DEFAULT_SETTINGS } from '../src/workflow/schema.js';

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

const LOOPING = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
  - id: ship
    type: implement
    config: { instructions: x }
edges:
  - { from: impl, to: check }
  - { from: check, to: ship }
  - { from: check, to: impl, loopback: true }
`;

describe('loop-back edges', () => {
  it('loads a graph with a loop-back and orders it over forward edges', () => {
    const wf = loadWorkflowFromString(LOOPING);
    expect(wf.order).toEqual(['impl', 'check', 'ship']);
  });

  it('keeps loop-backs out of dependency readiness', () => {
    const wf = loadWorkflowFromString(LOOPING);
    // `impl` must not wait on `check` just because a loop-back returns there.
    expect(wf.graph.directDependencies('impl')).toEqual([]);
    expect(wf.graph.directDependencies('check')).toEqual(['impl']);
  });

  it('applies the documented default bound when none is given', () => {
    const wf = loadWorkflowFromString(LOOPING);
    expect(wf.graph.loopbacksFrom('check')).toEqual([
      { from: 'check', to: 'impl', maxAttempts: DEFAULT_LOOPBACK_MAX_ATTEMPTS },
    ]);
  });

  it('accepts an explicit attempt bound', () => {
    const wf = loadWorkflowFromString(
      LOOPING.replace('loopback: true', 'loopback: { maxAttempts: 5 }'),
    );
    expect(wf.graph.loopbacksFrom('check')[0]!.maxAttempts).toBe(5);
  });

  it('rejects an attempt bound that is not a positive integer, naming the edge', () => {
    const problems = problemsOf(LOOPING.replace('loopback: true', 'loopback: { maxAttempts: 0 }'));
    expect(problems.join('\n')).toContain('check -> impl');
    expect(problems.join('\n')).toContain('maxAttempts');
  });

  it('rejects a loop-back that does not point at an ancestor', () => {
    const problems = problemsOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: validate
  - id: c
    type: implement
    config: { instructions: x }
edges:
  - { from: a, to: b }
  - { from: a, to: c }
  - { from: b, to: c, loopback: true }
`);
    expect(problems.join('\n')).toContain('b -> c');
    expect(problems.join('\n')).toContain('upstream');
  });

  it('rejects a loop-back pointing at its own source', () => {
    const problems = problemsOf(`
nodes:
  - id: a
    type: validate
edges:
  - { from: a, to: a, loopback: true }
`);
    expect(problems.join('\n')).toContain('own source');
  });

  it('still rejects a cycle formed by forward edges', () => {
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
  });

  it('computes the reset scope as the nodes on a path between target and source', () => {
    const wf = loadWorkflowFromString(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: mid
    type: test
    config: { commands: ["true"] }
  - id: aside
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
edges:
  - { from: impl, to: mid }
  - { from: mid, to: check }
  - { from: impl, to: aside }
  - { from: check, to: impl, loopback: true }
`);
    // `aside` hangs off impl but does not lead to check, so it is untouched.
    expect([...wf.graph.nodesBetween('impl', 'check')].sort()).toEqual(['check', 'impl', 'mid']);
  });
});

describe('default workflow template', () => {
  it('loads, and gates the git-mutating step behind an Approval-Gate', async () => {
    const { DEFAULT_WORKFLOW_YAML } = await import('../src/defaultWorkflow.js');
    const wf = loadWorkflowFromString(DEFAULT_WORKFLOW_YAML);
    expect(wf.nodes.map((n) => n.type.id)).toEqual([
      'discuss',
      'spec',
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

  it('ships loop-backs enabled, so a failed check iterates instead of stopping the run', async () => {
    const { DEFAULT_WORKFLOW_YAML } = await import('../src/defaultWorkflow.js');
    const wf = loadWorkflowFromString(DEFAULT_WORKFLOW_YAML);
    expect(wf.graph.allLoopbacks()).toEqual([
      { from: 'test', to: 'implement', maxAttempts: 3 },
      { from: 'validate', to: 'implement', maxAttempts: 3 },
      { from: 'review', to: 'implement', maxAttempts: 3 },
    ]);
    // A rejected gate still means stop: "no" is a decision, not a retry.
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
    // Loop-backs are return paths, not dependencies: implement must not wait
    // on the nodes that can send work back to it.
    expect(wf.graph.directDependencies('implement')).toEqual(['spec']);
  });
});

describe('node type registry', () => {
  it('registers all nine built-in types', () => {
    expect([...nodeTypeRegistry.keys()].sort()).toEqual(
      [
        'approval-gate',
        'discuss',
        'spec',
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

  it('tells implement it owns the tests, since the test node cannot write them', () => {
    // The Test node has no agent session and no `edit` capability, so a change
    // whose tests implement declines to write has nobody left to write them.
    const prompt = nodeTypeRegistry.get('implement')!.rolePrompt;
    expect(prompt).toMatch(/tests/i);
    expect(prompt).toMatch(/cannot write/i);
    expect(nodeTypeRegistry.get('test')!.agentDriven).toBe(false);
  });
});
