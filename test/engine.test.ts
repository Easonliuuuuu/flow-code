import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, TRUNCATION_MARKER, UPSTREAM_OUTPUT_LIMIT } from '../src/engine/engine.js';
import type { ExecuteContext, NodeExecutor, StatusEvent } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import type { NodeTypeId } from '../src/registry/index.js';
import type { RunBaseline } from '../src/runstate/types.js';
import { fakePorts, storeFor, throwingSessions, workflowFromYaml } from './helpers.js';

const BASELINE: RunBaseline = { commit: 'c0', tree: 't0', dirtyOverride: false };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-engine-'));
}

/** Node-id-keyed fake executors on top of the real engine. */
function engineWith(
  yaml: string,
  fakes: Record<string, NodeExecutor>,
  overrides: Partial<Record<NodeTypeId, NodeExecutor>> = {},
) {
  const workflow = workflowFromYaml(yaml);
  const repoRoot = tempDir();
  const store = storeFor(workflow, repoRoot);
  const dispatch: NodeExecutor = (ctx) => {
    const fake = fakes[ctx.node.id];
    if (!fake) throw new Error(`no fake executor for node ${ctx.node.id}`);
    return fake(ctx);
  };
  const executors = Object.fromEntries(
    Object.keys(builtinExecutors).map((k) => [k, overrides[k as NodeTypeId] ?? dispatch]),
  ) as Record<NodeTypeId, NodeExecutor>;
  const engine = new Engine({
    workflow,
    store,
    repoRoot,
    baseline: BASELINE,
    ports: fakePorts(),
    sessions: throwingSessions(),
    executors,
  });
  return { engine, store, workflow };
}

function doneAfter(output: unknown, body?: (ctx: ExecuteContext) => Promise<void>): NodeExecutor {
  return async function* (ctx): AsyncGenerator<StatusEvent, void, void> {
    yield { type: 'status', status: 'running' };
    if (body) await body(ctx);
    yield { type: 'result', output };
    yield { type: 'status', status: 'done' };
  };
}

const IMPL_OUT = { changedFiles: ['a.ts'], diff: 'diff --git', summary: 's' };

const LINEAR = `
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
`;

describe('DAG execution', () => {
  it('runs nodes in dependency order and records outputs', async () => {
    const started: string[] = [];
    const fake = (id: string): NodeExecutor =>
      doneAfter(IMPL_OUT, async () => {
        started.push(id);
      });
    const { engine, store } = engineWith(LINEAR, { a: fake('a'), b: fake('b'), c: fake('c') });
    await engine.run();
    expect(started).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      expect(store.node(id).status).toBe('done');
      expect(store.node(id).output).toEqual(IMPL_OUT);
    }
    expect(store.snapshot().finishedAt).toBeDefined();
  });

  it('injects direct dependency outputs, labelled by node id — not transitive ancestors', async () => {
    const seen: Record<string, string[]> = {};
    const fake = (id: string): NodeExecutor =>
      doneAfter({ ...IMPL_OUT, summary: `from-${id}` }, async (ctx) => {
        seen[id] = ctx.upstream.map((u) => u.nodeId);
        if (id === 'b') {
          expect(ctx.upstream[0]!.outputJson).toContain('from-a');
        }
        if (id === 'c') {
          expect(ctx.upstream.map((u) => u.nodeId)).toEqual(['b']);
        }
      });
    const { engine } = engineWith(LINEAR, { a: fake('a'), b: fake('b'), c: fake('c') });
    await engine.run();
    expect(seen['a']).toEqual([]);
    expect(seen['b']).toEqual(['a']);
    expect(seen['c']).toEqual(['b']);
  });

  it('truncates oversized upstream outputs with a marker, keeping the full value in run-state', async () => {
    const bigDiff = 'x'.repeat(UPSTREAM_OUTPUT_LIMIT * 2);
    let observed = '';
    const { engine, store } = engineWith(LINEAR, {
      a: doneAfter({ ...IMPL_OUT, diff: bigDiff }),
      b: doneAfter(IMPL_OUT, async (ctx) => {
        observed = ctx.upstream[0]!.outputJson;
        expect(ctx.upstream[0]!.truncated).toBe(true);
      }),
      c: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(observed.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(observed.length).toBeLessThan(bigDiff.length);
    expect((store.node('a').output as { diff: string }).diff).toHaveLength(bigDiff.length);
  });

  it('marks all downstream nodes of an errored node as skipped, not idle', async () => {
    const { engine, store } = engineWith(LINEAR, {
      a: doneAfter(IMPL_OUT),
      b: async function* (): AsyncGenerator<StatusEvent, void, void> {
        yield { type: 'status', status: 'running' };
        throw new Error('boom');
      },
      c: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('a').status).toBe('done');
    expect(store.node('b').status).toBe('error');
    expect(store.node('b').statusDetail).toContain('boom');
    expect(store.node('c').status).toBe('skipped');
  });

  it('serializes nodes that share the main working tree, even on independent branches', async () => {
    const yaml = `
nodes:
  - id: root
    type: implement
    config: { instructions: x }
  - id: left
    type: implement
    config: { instructions: x }
  - id: right
    type: implement
    config: { instructions: x }
edges:
  - { from: root, to: left }
  - { from: root, to: right }
`;
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = (): NodeExecutor =>
      doneAfter(IMPL_OUT, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });
    const { engine, store } = engineWith(yaml, { root: slow(), left: slow(), right: slow() });
    await engine.run();
    expect(maxConcurrent).toBe(1);
    expect(store.node('left').status).toBe('done');
    expect(store.node('right').status).toBe('done');
  });

  it('starts no new node while a Discuss node is active, but lets running nodes finish', async () => {
    const yaml = `
nodes:
  - id: talk
    type: discuss
  - id: side
    type: implement
    config: { instructions: x }
`;
    const events: string[] = [];
    const { engine, store } = engineWith(yaml, {
      talk: async function* (): AsyncGenerator<StatusEvent, void, void> {
        yield { type: 'status', status: 'waiting' };
        events.push('discuss-active');
        await new Promise((r) => setTimeout(r, 40));
        events.push('discuss-finished');
        yield { type: 'result', output: { conclusion: 'ok', constraints: [] } };
        yield { type: 'status', status: 'done' };
      },
      side: doneAfter(IMPL_OUT, async () => {
        events.push('side-started');
      }),
    });
    await engine.run();
    expect(store.node('talk').status).toBe('done');
    expect(store.node('side').status).toBe('done');
    expect(events.indexOf('side-started')).toBeGreaterThan(events.indexOf('discuss-finished'));
  });

  it('fails a node whose result does not match its output schema', async () => {
    const yaml = `
nodes:
  - id: a
    type: implement
    config: { instructions: x }
`;
    const { engine, store } = engineWith(yaml, {
      a: doneAfter({ wrong: true }),
    });
    await engine.run();
    expect(store.node('a').status).toBe('error');
    expect(store.node('a').statusDetail).toContain('output schema');
  });

  it('an executor that finishes without a terminal status is marked done', async () => {
    const yaml = `
nodes:
  - id: a
    type: implement
    config: { instructions: x }
`;
    const { engine, store } = engineWith(yaml, {
      a: async function* (): AsyncGenerator<StatusEvent, void, void> {
        yield { type: 'status', status: 'running' };
        yield { type: 'result', output: IMPL_OUT };
      },
    });
    await engine.run();
    expect(store.node('a').status).toBe('done');
  });
});
