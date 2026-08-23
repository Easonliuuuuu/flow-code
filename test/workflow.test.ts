import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/capabilities.js';
import { listNodeTypes, nodeTypeRegistry } from '../src/registry/index.js';
import {
  loadWorkflowFromString,
  stagesNotEvaluated,
  WorkflowValidationError,
  type LoadOptions,
} from '../src/workflow/load.js';
import {
  DEFAULT_LOOPBACK_MAX_ATTEMPTS,
  DEFAULT_SETTINGS,
  settingsSchema,
  SETTINGS_FIELDS,
} from '../src/workflow/schema.js';

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

function problemsOf(yaml: string, options?: LoadOptions): string[] {
  try {
    loadWorkflowFromString(yaml, options);
  } catch (err) {
    if (err instanceof WorkflowValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected workflow to be invalid');
}

function failureOf(yaml: string): WorkflowValidationError {
  try {
    loadWorkflowFromString(yaml);
  } catch (err) {
    if (err instanceof WorkflowValidationError) return err;
    throw err;
  }
  throw new Error('expected workflow to be invalid');
}

describe('workflow loading', () => {
  it('refuses a git-ops node given both a literal message and instructions', () => {
    const problems = problemsOf(`
nodes:
  - id: ship
    type: git-ops
    config:
      commitMessage: "chore: sync"
      instructions: write a conventional commit from the diff
`);
    // Both together are contradictory orders, and nothing downstream can tell
    // which was meant — so it fails at load, not silently at commit time.
    expect(problems.join('\n')).toContain('ship');
    expect(problems.join('\n')).toContain('cannot both be set');
  });

  it('accepts either one of them on its own', () => {
    // git-write needs a gate upstream, hence the two-node graph either way.
    const load = (config: string) =>
      loadWorkflowFromString(`
nodes:
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
    config: ${config}
edges:
  - { from: gate, to: ship }
`);
    expect(load('{ commitMessage: "chore: sync" }').nodes).toHaveLength(2);
    expect(load('{ instructions: "conventional commits, scope required" }').nodes).toHaveLength(2);
  });

  it('loads a valid workflow and applies documented settings defaults', () => {
    const wf = loadWorkflowFromString(VALID);
    expect(wf.nodes.map((n) => n.id)).toEqual(['impl', 'check']);
    expect(wf.settings).toEqual(DEFAULT_SETTINGS);
    expect(wf.settings.concurrency).toBe(2);
    expect(wf.settings.subagents).toBe(true);
    expect(wf.order).toEqual(['impl', 'check']);
  });

  it('lets a workflow turn delegation off without downgrading', () => {
    // The rollback lever for subagents: a subagent is bounded by its parent's
    // capability set either way, so this is about cost and predictability.
    const wf = loadWorkflowFromString(`
settings:
  subagents: false
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);
    expect(wf.settings.subagents).toBe(false);
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
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: gate, to: ship }
`);
    expect(wf.nodes.find((n) => n.id === 'ship')!.config).toEqual({});
  });
});

const NAMED_GRAPHS = `
settings:
  concurrency: 1
graphs:
  quick:
    description: Small, well-understood changes.
    nodes:
      - id: impl
        type: implement
        config: { instructions: do it fast }
    edges: []
  hardened:
    description: Risky changes — extra validation.
    nodes:
      - id: impl
        type: implement
        config: { instructions: do it carefully }
      - id: check
        type: test
        config: { commands: ["echo ok"] }
    edges:
      - { from: impl, to: check }
`;

describe('named graphs', () => {
  it('loads a single-graph (flat-form) file exactly as before, with no graph option', () => {
    const wf = loadWorkflowFromString(VALID);
    expect(wf.nodes.map((n) => n.id)).toEqual(['impl', 'check']);
  });

  it('loads the named graph asked for, applying the settings declared once at the top', () => {
    const quick = loadWorkflowFromString(NAMED_GRAPHS, { graph: 'quick' });
    expect(quick.nodes.map((n) => n.id)).toEqual(['impl']);
    expect(quick.settings.concurrency).toBe(1);

    const hardened = loadWorkflowFromString(NAMED_GRAPHS, { graph: 'hardened' });
    expect(hardened.nodes.map((n) => n.id)).toEqual(['impl', 'check']);
    expect(hardened.settings.concurrency).toBe(1);
  });

  it('auto-selects the sole declared graph when none is named', () => {
    const ONE = `
graphs:
  solo:
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
`;
    expect(loadWorkflowFromString(ONE).nodes.map((n) => n.id)).toEqual(['impl']);
  });

  it('fails, listing the declared names, when more than one graph is declared and none is named', () => {
    const failure = failureOf(NAMED_GRAPHS);
    expect(failure.problems.join('\n')).toMatch(/quick.*hardened|hardened.*quick/s);
  });

  it('fails, naming the requested graph, when the requested name is not declared', () => {
    const problems = problemsOf(NAMED_GRAPHS, { graph: 'nope' });
    expect(problems.join('\n')).toContain('`nope`');
    expect(problems.join('\n')).toMatch(/quick.*hardened|hardened.*quick/s);
  });

  it('rejects a file declaring both top-level nodes/edges and graphs, rather than resolving it by precedence', () => {
    const problems = problemsOf(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
graphs:
  quick:
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
`);
    expect(problems.join('\n')).toContain('both');
  });

  it('rejects a budget declared inside a named graph, naming the graph', () => {
    const problems = problemsOf(`
graphs:
  hardened:
    budget: { tokensPerRun: 1000 }
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
`);
    expect(problems.join('\n')).toContain('hardened');
    expect(problems.join('\n')).toContain('node.budget');
  });

  it('validates every named graph independently, attributing a failure to the graph it came from', () => {
    const BROKEN_HARDENED = `
graphs:
  quick:
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
  hardened:
    nodes:
      - id: impl
        type: no-such-node-type
`;
    let caught: WorkflowValidationError | undefined;
    try {
      loadWorkflowFromString(BROKEN_HARDENED, { graph: 'hardened' });
    } catch (err) {
      if (err instanceof WorkflowValidationError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.graph).toBe('hardened');
    expect(caught!.problems.join('\n')).toContain('no-such-node-type');

    // The other graph is unaffected — it loads cleanly on its own.
    expect(loadWorkflowFromString(BROKEN_HARDENED, { graph: 'quick' }).nodes.map((n) => n.id)).toEqual([
      'impl',
    ]);
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

describe('staged validation', () => {
  it('reports which stage stopped the load, so later checks are not read as passed', () => {
    // The distinction `flow-code validate` exists to report: a structural check
    // behind a parse failure did not pass, it never ran.
    const failure = failureOf('nodes: [oh: [dear');
    expect(failure.stage).toBe('parse');
    expect(stagesNotEvaluated(failure.stage)).toEqual(['file-schema', 'declarations', 'structure']);
  });

  it('reports every independent declaration failure in one pass', () => {
    const problems = problemsOf(`
nodes:
  - id: mystery
    type: no-such-type
  - id: impl
    type: implement
    config:
      instructions: 12
edges:
  - from: impl
    to: ghost
`);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('unknown node type `no-such-type`');
    expect(problems.join('\n')).toContain('`impl`');
    expect(problems.join('\n')).toContain('unknown node `ghost`');
  });

  it('reports independent structural failures together', () => {
    // A loop-back pointing the wrong way and a condition reading a node it
    // cannot see are unrelated; finding one should not hide the other.
    const failure = failureOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: x }
  - id: c
    type: implement
    config: { instructions: x }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: a, to: c, loopback: { maxAttempts: 2 } }
  - { from: a, to: b, when: "c.verdict == 'fail'" }
`);
    expect(failure.stage).toBe('structure');
    expect(failure.problems.length).toBeGreaterThan(1);
    expect(stagesNotEvaluated(failure.stage)).toEqual([]);
  });

  it('stops at the declaration stage without attempting structural checks', () => {
    const failure = failureOf(`
nodes:
  - id: mystery
    type: no-such-type
edges: []
`);
    expect(failure.stage).toBe('declarations');
    expect(stagesNotEvaluated(failure.stage)).toEqual(['structure']);
  });
});

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
      { from: 'check', to: 'impl', maxAttempts: DEFAULT_LOOPBACK_MAX_ATTEMPTS, on: 'failure' },
    ]);
  });

  it('accepts an explicit attempt bound', () => {
    const wf = loadWorkflowFromString(
      LOOPING.replace('loopback: true', 'loopback: { maxAttempts: 5 }'),
    );
    expect(wf.graph.loopbacksFrom('check')[0]!.maxAttempts).toBe(5);
  });

  it('accepts an explicit trigger, and defaults it to failure', () => {
    const onSuccess = loadWorkflowFromString(
      LOOPING.replace('loopback: true', 'loopback: { on: success }'),
    );
    expect(onSuccess.graph.loopbacksFrom('check')[0]!.on).toBe('success');
    // Unstated stays `failure`, so an existing workflow behaves as it always has.
    expect(loadWorkflowFromString(LOOPING).graph.loopbacksFrom('check')[0]!.on).toBe('failure');
    expect(
      loadWorkflowFromString(
        LOOPING.replace('loopback: true', 'loopback: { maxAttempts: 5 }'),
      ).graph.loopbacksFrom('check')[0]!.on,
    ).toBe('failure');
  });

  it('rejects a trigger that is not one of the two outcomes, naming the edge', () => {
    const problems = problemsOf(LOOPING.replace('loopback: true', 'loopback: { on: sometimes }'));
    expect(problems.join('\n')).toContain('check -> impl');
    expect(problems.join('\n')).toContain('on');
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
  it('loads, and gates both the spec and the git-mutating step behind an Approval-Gate', async () => {
    const { DEFAULT_WORKFLOW_YAML } = await import('../src/defaultWorkflow.js');
    const wf = loadWorkflowFromString(DEFAULT_WORKFLOW_YAML);
    expect(wf.nodes.map((n) => n.type.id)).toEqual([
      'discuss',
      'spec',
      'approval-gate',
      'implement',
      'test',
      'validate',
      'review',
      'approval-gate',
      'discuss',
      'git-ops',
    ]);
    const gitOps = wf.nodes.find((n) => n.type.id === 'git-ops')!;
    // Two gates of the same type now exist, so they are told apart by id
    // rather than by type — `gate` follows review, `spec-gate` follows spec.
    // Every path into git-ops passes `gate`; `gate` follows review.
    expect(wf.graph.directDependencies(gitOps.id)).toEqual(['gate']);
    expect(wf.graph.ancestorsOf('gate')).toContain('review');
    // Every path into implement passes `spec-gate`; `spec-gate` follows spec.
    expect(wf.graph.directDependencies('implement')).toEqual(['spec-gate']);
    expect(wf.graph.directDependencies('spec-gate')).toEqual(['spec']);
    // The scaffolded file states neither gate's forward condition — both are
    // synthesized by `withGateApprovalConditions` (load.ts:330), same as the
    // final gate's `gate -> git-ops` edge.
    const [implementCondition] = wf.graph.conditionsInto('implement');
    expect(implementCondition!.condition.source).toBe("spec-gate.decision == 'approved'");
    // The final gate states both arms of its decision explicitly, because a
    // rejection now routes somewhere rather than only ending the run — and an
    // implicit approval condition beside an explicit rejection one reads badly.
    const [gitOpsCondition] = wf.graph.conditionsInto(gitOps.id);
    expect(gitOpsCondition!.condition.source).toBe("gate.decision == 'approved'");
    const [reviseCondition] = wf.graph.conditionsInto('revise');
    expect(reviseCondition!.condition.source).toBe("gate.decision == 'rejected'");
    // The loop-back is a return path, not a forward edge, so it is exempt
    // from that synthesis — `discuss` carries no approval condition.
    expect(wf.graph.conditionsInto('discuss')).toHaveLength(0);
    // Default git-ops config: commit-only, no push.
    expect(gitOps.config).toEqual({});
  });

  it('ships loop-backs enabled, so a failed check iterates instead of stopping the run', async () => {
    const { DEFAULT_WORKFLOW_YAML } = await import('../src/defaultWorkflow.js');
    const wf = loadWorkflowFromString(DEFAULT_WORKFLOW_YAML);
    // Every verification loop-back is failure-triggered: a check that passes
    // has no reason to send the run back. `spec-gate`'s is triggered the same
    // way — `on: 'failure'` is the literal value, even though what actually
    // fires it is a rejection: `wasRejectedGate` reports a rejected gate to
    // the engine as though it had failed, specifically so a bare
    // `loopback: true` on its edge fires on rejection and nothing else.
    // `revise` is the exception: its loop-back is taken *because it finished*.
    // A conversation about what to change signals the retry by concluding, so
    // a return path waiting for it to fail would wait forever.
    expect(wf.graph.allLoopbacks()).toEqual([
      { from: 'spec-gate', to: 'discuss', maxAttempts: 3, on: 'failure' },
      { from: 'revise', to: 'implement', maxAttempts: 3, on: 'success' },
      { from: 'test', to: 'implement', maxAttempts: 3, on: 'failure' },
      { from: 'validate', to: 'implement', maxAttempts: 3, on: 'failure' },
      { from: 'review', to: 'implement', maxAttempts: 3, on: 'failure' },
    ]);
    // The final gate itself never loops back: it routes forward to `revise`,
    // which is what carries the work back. A gate has no way to say *why* it
    // was rejected, so looping straight from it would retry on nothing but
    // "a human said no".
    expect(wf.graph.loopbacksFrom('gate')).toEqual([]);
    // Every loop-back into `implement` shares one attempt bound, counted on
    // the target. `revise` matching the verification loops is load-bearing: a
    // lower number would let one earlier test failure spend the budget and
    // leave the revision path dead, after the conversation had already run.
    const intoImplement = wf.graph.allLoopbacks().filter((l) => l.to === 'implement');
    expect(new Set(intoImplement.map((l) => l.maxAttempts))).toEqual(new Set([3]));
    // Loop-backs are return paths, not dependencies: implement must not wait
    // on the nodes that can send work back to it, and discuss must not wait
    // on spec-gate.
    expect(wf.graph.directDependencies('implement')).toEqual(['spec-gate']);
    expect(wf.graph.directDependencies('discuss')).toEqual([]);
  });
});

describe('node type registry', () => {
  it('registers all ten built-in types', () => {
    expect([...nodeTypeRegistry.keys()].sort()).toEqual(
      [
        'approval-gate',
        'discuss',
        'plan',
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

describe('git-write nodes must be gated', () => {
  it('rejects a git-writing node with no gate anywhere upstream', () => {
    const problems = problemsOf(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: ship }
`);
    expect(problems.join('\n')).toContain('ship');
    expect(problems.join('\n')).toContain('git-write');
    expect(problems.join('\n')).toContain('Approval-Gate');
  });

  it('rejects a git-writing node reachable both through a gate and by a bypass', () => {
    const problems = problemsOf(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: gate }
  - { from: gate, to: ship }
  - { from: impl, to: ship }
`);
    expect(problems.join('\n')).toContain('ship');
  });

  it('rejects a bypass even when it carries a `when:` condition', () => {
    const problems = problemsOf(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: check }
  - { from: check, to: gate }
  - { from: gate, to: ship }
  - { from: check, to: ship, when: "check.verdict == 'pass'" }
`);
    expect(problems.join('\n')).toContain('ship');
  });

  it('accepts a git-writing node dominated by a gate', () => {
    const wf = loadWorkflowFromString(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: gate }
  - { from: gate, to: ship }
`);
    expect(wf.nodes.map((n) => n.id)).toEqual(['impl', 'gate', 'ship']);
  });

  it('accepts two independent branches, each gated by its own Approval-Gate', () => {
    const wf = loadWorkflowFromString(`
nodes:
  - id: implA
    type: implement
    config: { instructions: x }
  - id: gateA
    type: approval-gate
  - id: shipA
    type: git-ops
  - id: implB
    type: implement
    config: { instructions: x }
  - id: gateB
    type: approval-gate
  - id: shipB
    type: git-ops
edges:
  - { from: implA, to: gateA }
  - { from: gateA, to: shipA }
  - { from: implB, to: gateB }
  - { from: gateB, to: shipB }
`);
    expect(wf.nodes.map((n) => n.id)).toEqual(['implA', 'gateA', 'shipA', 'implB', 'gateB', 'shipB']);
  });

  it('requires no gate at all when the graph writes to git nowhere', () => {
    const wf = loadWorkflowFromString(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: test
    config: { commands: ["true"] }
edges:
  - { from: impl, to: check }
`);
    expect(wf.nodes.map((n) => n.id)).toEqual(['impl', 'check']);
  });

  it('reports an ungated git-write node alongside an unrelated structural failure', () => {
    const failure = failureOf(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: x }
  - id: ship
    type: git-ops
edges:
  - { from: a, to: b }
  - { from: b, to: ship }
  - { from: a, to: b, loopback: true }
`);
    expect(failure.stage).toBe('structure');
    expect(failure.problems.join('\n')).toContain('ship');
    expect(failure.problems.join('\n')).toContain('git-write');
    expect(failure.problems.join('\n')).toContain('upstream');
    expect(failure.problems.length).toBeGreaterThan(1);
  });

  it('has no opt-out: an unrecognized settings key meant to disarm the gate is rejected like any other unknown key', () => {
    const problems = problemsOf(`
settings:
  allowUngatedGitWrite: true
nodes:
  - id: ship
    type: git-ops
`);
    expect(problems.join('\n')).toMatch(/allowUngatedGitWrite|Unrecognized/i);
  });

  it('the default scaffold and both shipped presets satisfy the invariant', async () => {
    const { DEFAULT_WORKFLOW_YAML } = await import('../src/defaultWorkflow.js');
    const { listPresets } = await import('../src/presets.js');
    expect(() => loadWorkflowFromString(DEFAULT_WORKFLOW_YAML)).not.toThrow();
    for (const preset of listPresets()) {
      expect(() => loadWorkflowFromString(preset.yaml), preset.name).not.toThrow();
    }
  });
});

describe('a graph declares at most one plan node, at its root', () => {
  it('rejects a second plan node', () => {
    const problems = problemsOf(`
nodes:
  - id: plan1
    type: plan
  - id: plan2
    type: plan
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: plan1, to: gate }
  - { from: plan2, to: gate }
  - { from: gate, to: ship }
`);
    expect(problems.join('\n')).toContain('plan1');
    expect(problems.join('\n')).toContain('plan2');
    expect(problems.join('\n')).toContain('at most one');
  });

  it('rejects a plan node with an upstream dependency', () => {
    const problems = problemsOf(`
nodes:
  - id: talk
    type: discuss
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: talk, to: plan }
  - { from: plan, to: gate }
  - { from: gate, to: ship }
`);
    expect(problems.join('\n')).toContain('plan');
    expect(problems.join('\n')).toContain('root');
  });

  it('accepts a single plan node at the root', () => {
    const wf = loadWorkflowFromString(`
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: ship }
`);
    expect(wf.nodes.map((n) => n.id)).toEqual(['plan', 'gate', 'ship']);
  });

  it('has nothing to enforce when the graph declares no plan node', () => {
    expect(() => loadWorkflowFromString(VALID)).not.toThrow();
  });
});

describe('SETTINGS_FIELDS', () => {
  /**
   * The generated settings table in the workflow reference is only as
   * trustworthy as this parity. `settings.notifications` and `settings.subagents`
   * both shipped and went undocumented for exactly as long as nothing checked.
   */
  it('documents every settings key, and no key that is not one', () => {
    const documented = SETTINGS_FIELDS.map((f) => f.name).sort();
    const actual = Object.keys(settingsSchema.shape).sort();

    expect(documented).toEqual(actual);
  });

  it('gives each field a type, a default and a description to render', () => {
    for (const field of SETTINGS_FIELDS) {
      expect(field.type).not.toBe('');
      expect(field.default).not.toBe('');
      expect(field.description.length).toBeGreaterThan(20);
    }
  });
});
