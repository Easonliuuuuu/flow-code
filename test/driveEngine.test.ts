import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driveEngine } from '../src/cli/run.js';
import { Engine } from '../src/engine/engine.js';
import type { NodeExecutor, StatusEvent } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import type { NodeTypeId } from '../src/registry/index.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { RunBaseline } from '../src/runstate/types.js';
import { fakePorts, throwingSessions, workflowFromYaml } from './helpers.js';

const BASELINE: RunBaseline = { commit: 'c0', tree: 't0', dirtyOverride: false };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-drive-engine-'));
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

describe('driveEngine', () => {
  it('runs through a Plan expansion end to end, on one store, to a finished outcome', async () => {
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

    const fakes: Record<string, NodeExecutor> = {
      plan: doneAfter(PROPOSAL_OUTPUT),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }),
      'git-ops': doneAfter({ committed: true, pushed: false }),
      impl: doneAfter({ changedFiles: ['a.ts'], diff: 'd', summary: 's' }),
    };
    const dispatch: NodeExecutor = (ctx) => {
      const fake = fakes[ctx.node.id];
      if (!fake) throw new Error(`no fake executor for node ${ctx.node.id}`);
      return fake(ctx);
    };
    const executors = Object.fromEntries(
      Object.keys(builtinExecutors).map((k) => [k, dispatch]),
    ) as Record<NodeTypeId, NodeExecutor>;
    const newEngine = (wf: typeof workflow): Engine =>
      new Engine({
        workflow: wf,
        store,
        repoRoot,
        baseline: BASELINE,
        ports: fakePorts(),
        sessions: throwingSessions(),
        executors,
      });

    const finalWorkflow = await driveEngine(newEngine(workflow), workflow, {
      store,
      repoRoot,
      newEngine,
    });

    expect(store.node('plan').status).toBe('done');
    expect(store.node('impl').status).toBe('done');
    expect(store.node('gate').status).toBe('done');
    expect(store.node('git-ops').status).toBe('done');
    expect(store.snapshot().graph!.nodes.map((n) => n.id)).toEqual(['plan', 'gate', 'git-ops', 'impl']);
    // Reference-inequality is the signal `cmdRun` uses to offer keeping the
    // graph — worth pinning directly, since nothing else enforces the contract.
    expect(finalWorkflow).not.toBe(workflow);
    expect(finalWorkflow.nodes.map((n) => n.id)).toEqual(['plan', 'gate', 'git-ops', 'impl']);
  });

  it('finishes in one pass, never touching expandGraph, when the graph has no Plan node', async () => {
    const repoRoot = tempDir();
    const workflow = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);
    const store = new RunStateStore({
      repoRoot,
      graph: {
        settings: workflow.settings,
        nodes: workflow.nodes.map((n) => ({ id: n.id, type: n.type.id, config: n.config })),
        edges: [],
      },
    });
    const originalGraph = store.snapshot().graph;

    const executors = Object.fromEntries(
      Object.keys(builtinExecutors).map((k) => [
        k,
        doneAfter({ changedFiles: [], diff: '', summary: 's' }),
      ]),
    ) as Record<NodeTypeId, NodeExecutor>;
    const newEngine = (wf: typeof workflow): Engine =>
      new Engine({
        workflow: wf,
        store,
        repoRoot,
        baseline: BASELINE,
        ports: fakePorts(),
        sessions: throwingSessions(),
        executors,
      });

    const finalWorkflow = await driveEngine(newEngine(workflow), workflow, {
      store,
      repoRoot,
      newEngine,
    });

    expect(store.node('impl').status).toBe('done');
    // The graph object was never replaced — no expansion happened.
    expect(store.snapshot().graph).toBe(originalGraph);
    expect(finalWorkflow).toBe(workflow);
  });
});
