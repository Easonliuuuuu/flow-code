import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import type { NodeExecutor, StatusEvent } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import type { NodeTypeId } from '../src/registry/index.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { RunBaseline, RunState } from '../src/runstate/types.js';
import { expandRecordedGraph, rehydrateGraph } from '../src/workflow/record.js';
import { fakePorts, throwingSessions, workflowFromYaml } from './helpers.js';

const BASELINE: RunBaseline = { commit: 'c0', tree: 't0', dirtyOverride: false };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-expand-'));
}

const SPINE = `
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: git-ops }
`;

function doneAfter(output: unknown): NodeExecutor {
  return async function* (): AsyncGenerator<StatusEvent, void, void> {
    yield { type: 'status', status: 'running' };
    yield { type: 'result', output };
    yield { type: 'status', status: 'done' };
  };
}

const PROPOSAL_OUTPUT = {
  nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
  edges: [],
};

function engineFor(
  repoRoot: string,
  workflow: ReturnType<typeof workflowFromYaml>,
  store: RunStateStore,
  fakes: Record<string, NodeExecutor>,
): Engine {
  const dispatch: NodeExecutor = (ctx) => {
    const fake = fakes[ctx.node.id];
    if (!fake) throw new Error(`no fake executor for node ${ctx.node.id}`);
    return fake(ctx);
  };
  const executors = Object.fromEntries(
    Object.keys(builtinExecutors).map((k) => [k, dispatch]),
  ) as Record<NodeTypeId, NodeExecutor>;
  return new Engine({
    workflow,
    store,
    repoRoot,
    baseline: BASELINE,
    ports: fakePorts(),
    sessions: throwingSessions(),
    executors,
  });
}

describe('the engine stops for expansion rather than starting a Plan node\'s successors', () => {
  it('returns awaiting-expansion, and gate/git-ops never leave idle', async () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(SPINE);
    const store = new RunStateStore({
      repoRoot,
      graph: {
        settings: workflow.settings,
        nodes: workflow.nodes.map((n) => ({ id: n.id, type: n.type.id, config: n.config })),
        edges: workflow.edges,
      },
    });

    const engine = engineFor(repoRoot, workflow, store, {
      plan: doneAfter(PROPOSAL_OUTPUT),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }),
      'git-ops': doneAfter({ committed: true, pushed: false }),
    });

    const outcome = await engine.run();

    expect(outcome).toEqual({ reason: 'awaiting-expansion', planNodeId: 'plan' });
    expect(store.node('plan').status).toBe('done');
    expect(store.node('gate').status).toBe('idle');
    expect(store.node('git-ops').status).toBe('idle');
  });

  it('lets an unrelated node already running in the same pass finish rather than abandoning it', async () => {
    const repoRoot = tempDir();
    // `aside` declared before `plan`: `startEligible` processes roots in
    // declaration order, and starting `plan` freezes further starts in the
    // same pass — so `aside` only gets a chance to start alongside it if it
    // is considered first, which is what actually exercises the drain.
    const workflow = workflowFromYaml(`
nodes:
  - id: aside
    type: implement
    config: { instructions: x }
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: git-ops }
`);
    const store = new RunStateStore({
      repoRoot,
      graph: { settings: workflow.settings, nodes: workflow.nodes.map((n) => ({ id: n.id, type: n.type.id, config: n.config })), edges: workflow.edges },
    });

    let asideResolve!: () => void;
    const asideGate = new Promise<void>((resolve) => {
      asideResolve = resolve;
    });
    const engine = engineFor(repoRoot, workflow, store, {
      plan: doneAfter(PROPOSAL_OUTPUT),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }),
      'git-ops': doneAfter({ committed: true, pushed: false }),
      aside: async function* (): AsyncGenerator<StatusEvent, void, void> {
        yield { type: 'status', status: 'running' };
        await asideGate;
        yield { type: 'result', output: { changedFiles: [], diff: '', summary: 's' } };
        yield { type: 'status', status: 'done' };
      },
    });

    const runPromise = engine.run();
    // Let `plan` (synchronous fake) resolve, then release `aside`.
    await new Promise((r) => setTimeout(r, 10));
    asideResolve();
    const outcome = await runPromise;

    expect(outcome).toEqual({ reason: 'awaiting-expansion', planNodeId: 'plan' });
    expect(store.node('aside').status).toBe('done');
  });
});

describe('expandRecordedGraph', () => {
  it('produces a workflow and recorded graph that round-trip through rehydrateGraph', () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(SPINE);

    const { workflow: expanded, graph } = expandRecordedGraph(workflow, 'plan', PROPOSAL_OUTPUT, {
      repoRoot,
    });

    expect(expanded.nodes.map((n) => n.id)).toEqual(['plan', 'gate', 'git-ops', 'impl']);
    const rehydrated = rehydrateGraph(graph, { repoRoot });
    expect(rehydrated.nodes.map((n) => n.id).sort()).toEqual(expanded.nodes.map((n) => n.id).sort());
    expect(rehydrated.graph.ancestorsOf('git-ops')).toContain('gate');
  });

  it('rejects an accepted proposal that turns out to violate the gate invariant', () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(SPINE);
    expect(() =>
      expandRecordedGraph(
        workflow,
        'plan',
        {
          nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
          edges: [{ from: 'impl', to: 'git-ops' }],
        },
        { repoRoot },
      ),
    ).toThrow(/git-write/);
  });
});

describe('RunStateStore.expandGraph', () => {
  it('adds the new nodes idle and leaves everything already recorded untouched', () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(SPINE);
    const store = new RunStateStore({
      repoRoot,
      graph: { settings: workflow.settings, nodes: workflow.nodes.map((n) => ({ id: n.id, type: n.type.id, config: n.config })), edges: workflow.edges },
    });
    store.setStatus('plan', 'done');
    store.setOutput('plan', PROPOSAL_OUTPUT);

    const { graph } = expandRecordedGraph(workflow, 'plan', PROPOSAL_OUTPUT, { repoRoot });
    store.expandGraph(graph);

    expect(store.node('plan').status).toBe('done');
    expect(store.node('plan').output).toEqual(PROPOSAL_OUTPUT);
    expect(store.node('gate').status).toBe('idle');
    expect(store.node('impl').status).toBe('idle');
    expect(store.snapshot().graph!.nodes.map((n) => n.id)).toEqual(['plan', 'gate', 'git-ops', 'impl']);
  });
});

describe('resuming across an expansion', () => {
  it('resuming after expansion runs the expanded graph, past a Plan node that is not re-entered', async () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(SPINE);
    const { graph } = expandRecordedGraph(workflow, 'plan', PROPOSAL_OUTPUT, { repoRoot });

    const priorState: RunState = {
      runId: 'run-resume-after',
      createdAt: new Date().toISOString(),
      repoRoot,
      pid: 0,
      baseline: BASELINE,
      nodes: {
        plan: { status: 'done', denials: 0, output: PROPOSAL_OUTPUT },
        gate: { status: 'idle', denials: 0 },
        'git-ops': { status: 'idle', denials: 0 },
        impl: { status: 'idle', denials: 0 },
      },
      worktrees: [],
      activity: [],
      graph,
    };

    const rehydrated = rehydrateGraph(graph, { repoRoot });
    const store = new RunStateStore({ repoRoot, graph, resumeFrom: priorState });
    let planRan = false;
    const engine = engineFor(repoRoot, rehydrated, store, {
      plan: async function* (): AsyncGenerator<StatusEvent, void, void> {
        planRan = true;
        yield { type: 'status', status: 'done' };
      },
      impl: doneAfter({ changedFiles: ['a.ts'], diff: 'd', summary: 's' }),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }),
      'git-ops': doneAfter({ committed: true, pushed: false }),
    });

    const outcome = await engine.run();

    expect(planRan).toBe(false);
    expect(outcome).toEqual({ reason: 'finished' });
    expect(store.node('impl').status).toBe('done');
    expect(store.node('gate').status).toBe('done');
    expect(store.node('git-ops').status).toBe('done');
  });

  it('resuming before expansion re-enters the Plan node rather than treating it as complete', async () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(SPINE);

    const priorState: RunState = {
      runId: 'run-resume-before',
      createdAt: new Date().toISOString(),
      repoRoot,
      pid: 0,
      baseline: BASELINE,
      nodes: {
        // Interrupted mid-negotiation: not done.
        plan: { status: 'idle', denials: 0 },
        gate: { status: 'idle', denials: 0 },
        'git-ops': { status: 'idle', denials: 0 },
      },
      worktrees: [],
      activity: [],
      graph: { settings: workflow.settings, nodes: workflow.nodes.map((n) => ({ id: n.id, type: n.type.id, config: n.config })), edges: workflow.edges },
    };

    const store = new RunStateStore({ repoRoot, graph: priorState.graph!, resumeFrom: priorState });
    let planRan = false;
    const engine = engineFor(repoRoot, workflow, store, {
      plan: async function* (): AsyncGenerator<StatusEvent, void, void> {
        planRan = true;
        yield { type: 'status', status: 'running' };
        yield { type: 'result', output: PROPOSAL_OUTPUT };
        yield { type: 'status', status: 'done' };
      },
    });

    const outcome = await engine.run();

    expect(planRan).toBe(true);
    expect(outcome).toEqual({ reason: 'awaiting-expansion', planNodeId: 'plan' });
    expect(store.node('plan').status).toBe('done');
    expect(store.node('gate').status).toBe('idle');
  });
});
