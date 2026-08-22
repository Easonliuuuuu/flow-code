import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, TRUNCATION_MARKER, UPSTREAM_OUTPUT_LIMIT } from '../src/engine/engine.js';
import type {
  ExecuteContext,
  NodeExecutor,
  StatusEvent,
  UpstreamInput,
} from '../src/engine/types.js';
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
  signal?: AbortSignal,
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
    ...(signal ? { signal } : {}),
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

  it('ctx.signal carries the run signal into every executor', async () => {
    const controller = new AbortController();
    const yaml = `
nodes:
  - id: a
    type: implement
    config: { instructions: x }
`;
    const { engine } = engineWith(
      yaml,
      { a: doneAfter(IMPL_OUT, async (ctx) => expect(ctx.signal).toBe(controller.signal)) },
      {},
      controller.signal,
    );
    await engine.run();
  });

  it('interrupting mid-run stops new work and skips unrelated idle nodes with a distinct reason', async () => {
    // 'a' and 'b' are independent (no edges), but share the main-tree lock —
    // 'b' is still idle, waiting its turn, when 'a' gets interrupted.
    const yaml = `
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: x }
`;
    const controller = new AbortController();
    const { engine, store } = engineWith(
      yaml,
      {
        a: async function* (): AsyncGenerator<StatusEvent, void, void> {
          yield { type: 'status', status: 'running' };
          // Simulate ctrl+c firing while this node is mid-flight.
          controller.abort();
          throw new Error('interrupted');
        },
        b: doneAfter(IMPL_OUT),
      },
      {},
      controller.signal,
    );
    await engine.run();
    expect(store.node('a').status).toBe('error');
    expect(store.node('b').status).toBe('skipped');
    expect(store.node('b').statusDetail).toBe('run interrupted');
    expect(store.snapshot().finishedAt).toBeDefined();
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

const GATED = `
nodes:
  - id: propose
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: apply
    type: implement
    config: { instructions: x }
edges:
  - { from: propose, to: gate }
  - { from: gate, to: apply }
`;

const GATE_OUT = { decision: 'approved', decidedAt: '2026-08-02T00:00:00Z' };

describe('context propagation across transparent nodes', () => {
  it('forwards the gate’s upstream outputs alongside its decision', async () => {
    let seen: UpstreamInput[] = [];
    const { engine } = engineWith(GATED, {
      propose: doneAfter({ ...IMPL_OUT, summary: 'change: add-user-auth' }),
      gate: doneAfter(GATE_OUT),
      apply: doneAfter(IMPL_OUT, async (ctx) => {
        seen = ctx.upstream;
      }),
    });
    await engine.run();
    expect(seen.map((u) => u.nodeId)).toEqual(['propose', 'gate']);
    // The node after the gate can still tell which change it is implementing.
    expect(seen.find((u) => u.nodeId === 'propose')!.outputJson).toContain('add-user-auth');
    expect(seen.find((u) => u.nodeId === 'gate')!.outputJson).toContain('approved');
  });

  it('marks forwarded outputs as forwarded and direct ones as not', async () => {
    let seen: UpstreamInput[] = [];
    const { engine } = engineWith(GATED, {
      propose: doneAfter(IMPL_OUT),
      gate: doneAfter(GATE_OUT),
      apply: doneAfter(IMPL_OUT, async (ctx) => {
        seen = ctx.upstream;
      }),
    });
    await engine.run();
    expect(seen.find((u) => u.nodeId === 'propose')!.forwarded).toBe(true);
    expect(seen.find((u) => u.nodeId === 'gate')!.forwarded).toBeUndefined();
  });

  it('composes through chained transparent nodes, injecting each output once', async () => {
    const yaml = `
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: g1
    type: approval-gate
  - id: g2
    type: approval-gate
  - id: z
    type: implement
    config: { instructions: x }
edges:
  - { from: a, to: g1 }
  - { from: g1, to: g2 }
  - { from: g2, to: z }
`;
    let seen: string[] = [];
    const { engine } = engineWith(yaml, {
      a: doneAfter(IMPL_OUT),
      g1: doneAfter(GATE_OUT),
      g2: doneAfter(GATE_OUT),
      z: doneAfter(IMPL_OUT, async (ctx) => {
        seen = ctx.upstream.map((u) => u.nodeId);
      }),
    });
    await engine.run();
    expect(seen).toEqual(['a', 'g1', 'g2']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('still does not propagate ancestors reached only through opaque nodes', async () => {
    let seen: string[] = [];
    const { engine } = engineWith(LINEAR, {
      a: doneAfter(IMPL_OUT),
      b: doneAfter(IMPL_OUT),
      c: doneAfter(IMPL_OUT, async (ctx) => {
        seen = ctx.upstream.map((u) => u.nodeId);
      }),
    });
    await engine.run();
    // `b` is an Implement node: opaque, so `a` does not reach `c`.
    expect(seen).toEqual(['b']);
  });

  it('truncates forwarded context against one shared budget', async () => {
    const big = 'x'.repeat(UPSTREAM_OUTPUT_LIMIT * 2);
    let seen: UpstreamInput[] = [];
    const { engine, store } = engineWith(GATED, {
      propose: doneAfter({ ...IMPL_OUT, diff: big }),
      gate: doneAfter(GATE_OUT),
      apply: doneAfter(IMPL_OUT, async (ctx) => {
        seen = ctx.upstream;
      }),
    });
    await engine.run();
    const total = seen.reduce((n, u) => n + u.outputJson.length, 0);
    expect(total).toBeLessThan(big.length);
    expect(seen.some((u) => u.truncated)).toBe(true);
    // Every dependency is still present, and run-state keeps the full value.
    expect(seen.map((u) => u.nodeId)).toEqual(['propose', 'gate']);
    expect((store.node('propose').output as { diff: string }).diff).toHaveLength(big.length);
  });
});

const VERIFY = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
  - id: after
    type: implement
    config: { instructions: x }
edges:
  - { from: impl, to: check }
  - { from: check, to: after }
`;

describe('output-conditional failure', () => {
  it('errors a node whose type declares its output a failure, keeping the output', async () => {
    const failing = { verdict: 'fail', notes: 'task 3 was never implemented' };
    const { engine, store } = engineWith(VERIFY, {
      impl: doneAfter(IMPL_OUT),
      check: doneAfter(failing),
      after: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('check').status).toBe('error');
    // The verdict is still recorded in full — failing is not losing the result.
    // (`criteria` is filled in by the output schema's default.)
    expect(store.node('check').output).toMatchObject(failing);
    expect(store.node('check').statusDetail).toContain('fail');
  });

  it('does not let a failed verdict reach downstream nodes', async () => {
    const { engine, store } = engineWith(VERIFY, {
      impl: doneAfter(IMPL_OUT),
      check: doneAfter({ verdict: 'fail', notes: 'no' }),
      after: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('after').status).toBe('skipped');
  });

  it('completes a node whose predicate does not hold', async () => {
    const { engine, store } = engineWith(VERIFY, {
      impl: doneAfter(IMPL_OUT),
      check: doneAfter({ verdict: 'pass', notes: 'all good' }),
      after: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('check').status).toBe('done');
    expect(store.node('after').status).toBe('done');
  });

  it('overrides an explicit done from the executor', async () => {
    const { engine, store } = engineWith(VERIFY, {
      impl: doneAfter(IMPL_OUT),
      // doneAfter yields `status: done` itself; the predicate still wins.
      check: doneAfter({ verdict: 'fail', notes: 'no' }),
      after: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('check').status).toBe('error');
  });

  it('leaves node types without a failure predicate unaffected', async () => {
    const { engine, store } = engineWith(LINEAR, {
      a: doneAfter(IMPL_OUT),
      // An Implement node declares no predicate: a `verdict` field in its
      // output means nothing to the engine.
      b: doneAfter({ ...IMPL_OUT, summary: 'verdict: fail' }),
      c: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('b').status).toBe('done');
    expect(store.node('c').status).toBe('done');
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
  - { from: check, to: impl, loopback: { maxAttempts: 3 } }
`;

/** Fails its first `failures` runs, then passes. */
function flaky(failures: number): { executor: NodeExecutor; runs: () => number } {
  let runs = 0;
  const executor: NodeExecutor = async function* (): AsyncGenerator<StatusEvent, void, void> {
    runs++;
    yield { type: 'status', status: 'running' };
    yield {
      type: 'result',
      output:
        runs <= failures
          ? { verdict: 'fail', notes: `attempt ${runs} found a problem` }
          : { verdict: 'pass', notes: 'looks good' },
    };
  };
  return { executor, runs: () => runs };
}

describe('loop-back execution', () => {
  it('re-runs the segment and continues once the retry passes', async () => {
    const check = flaky(1);
    let implRuns = 0;
    const { engine, store } = engineWith(LOOPING, {
      impl: doneAfter(IMPL_OUT, async () => {
        implRuns++;
      }),
      check: check.executor,
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(implRuns).toBe(2);
    expect(check.runs()).toBe(2);
    expect(store.node('check').status).toBe('done');
    expect(store.node('ship').status).toBe('done');
    expect(store.attemptOf('impl')).toBe(2);
  });

  it('records prior attempts on the re-run nodes', async () => {
    const check = flaky(1);
    const { engine, store } = engineWith(LOOPING, {
      impl: doneAfter(IMPL_OUT),
      check: check.executor,
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.node('check').priorAttempts).toHaveLength(1);
    expect(store.node('check').priorAttempts![0]!.status).toBe('error');
  });

  it('tells the retried node why it is running again', async () => {
    const check = flaky(1);
    const seen: string[][] = [];
    const { engine } = engineWith(LOOPING, {
      impl: doneAfter(IMPL_OUT, async (ctx) => {
        seen.push(ctx.upstream.map((u) => u.outputJson));
      }),
      check: check.executor,
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(seen).toHaveLength(2);
    // First pass knows nothing; the retry carries the failure that caused it.
    expect(seen[0]).toEqual([]);
    expect(seen[1]!.join('\n')).toContain('attempt 1 found a problem');
    expect(seen[1]!.join('\n')).toContain('"failedNode": "check"');
  });

  it('stops at the attempt bound and skips downstream', async () => {
    const check = flaky(Number.MAX_SAFE_INTEGER);
    const { engine, store } = engineWith(LOOPING, {
      impl: doneAfter(IMPL_OUT),
      check: check.executor,
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();
    // maxAttempts 3 on the target: attempts 1, 2, 3, then the loop is spent.
    expect(check.runs()).toBe(3);
    expect(store.node('check').status).toBe('error');
    expect(store.node('check').statusDetail).toContain('attempt limit');
    expect(store.node('ship').status).toBe('skipped');
    expect(store.snapshot().finishedAt).toBeDefined();
  });

  it('leaves nodes off the failure path untouched', async () => {
    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: aside
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
edges:
  - { from: impl, to: check }
  - { from: impl, to: aside }
  - { from: check, to: impl, loopback: { maxAttempts: 2 } }
`;
    const check = flaky(1);
    let asideRuns = 0;
    const { engine, store } = engineWith(yaml, {
      impl: doneAfter(IMPL_OUT),
      aside: doneAfter({ ...IMPL_OUT, summary: 'aside result' }, async () => {
        asideRuns++;
      }),
      check: check.executor,
    });
    await engine.run();
    expect(asideRuns).toBe(1);
    expect(store.attemptOf('aside')).toBe(1);
    expect((store.node('aside').output as { summary: string }).summary).toBe('aside result');
  });

  it('re-runs the segment when a gate is rejected and a loop-back is declared', async () => {
    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: ship
    type: implement
    config: { instructions: x }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: ship }
  - { from: gate, to: impl, loopback: { maxAttempts: 2 } }
`;
    let implRuns = 0;
    let gateRuns = 0;
    const { engine, store } = engineWith(yaml, {
      impl: doneAfter(IMPL_OUT, async () => {
        implRuns++;
      }),
      gate: async function* (): AsyncGenerator<StatusEvent, void, void> {
        gateRuns++;
        yield { type: 'status', status: 'running' };
        const rejected = gateRuns === 1;
        yield {
          type: 'result',
          output: {
            decision: rejected ? 'rejected' : 'approved',
            decidedAt: new Date().toISOString(),
          },
        };
        // Both decisions end at `done`; the rejection lives in the output. The
        // loop-back has to fire off that, not off a failed status.
        yield rejected
          ? { type: 'status', status: 'done', detail: 'rejected by user' }
          : { type: 'status', status: 'done' };
      },
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(implRuns).toBe(2);
    expect(store.node('ship').status).toBe('done');
  });

  it('skips the approval branch when a rejected gate has no loop-back', async () => {
    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: ship
    type: implement
    config: { instructions: x }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: ship }
`;
    let implRuns = 0;
    let shipRuns = 0;
    const { engine, store } = engineWith(yaml, {
      impl: doneAfter(IMPL_OUT, async () => {
        implRuns++;
      }),
      gate: doneAfter({ decision: 'rejected', decidedAt: new Date().toISOString() }),
      ship: doneAfter(IMPL_OUT, async () => {
        shipRuns++;
      }),
    });
    await engine.run();
    expect(implRuns).toBe(1);
    expect(shipRuns).toBe(0);
    expect(store.node('gate').status).toBe('done');
    // Routed away from, not cascaded over: nothing failed here.
    expect(store.node('ship').status).toBe('skipped');
    expect(store.node('ship').skipReason).toBe('condition');
  });

  it('still skips downstream on failure when no loop-back is declared', async () => {
    const check = flaky(Number.MAX_SAFE_INTEGER);
    const { engine, store } = engineWith(VERIFY, {
      impl: doneAfter(IMPL_OUT),
      check: check.executor,
      after: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(check.runs()).toBe(1);
    expect(store.node('after').status).toBe('skipped');
  });

  it('terminates a run whose loop never converges', async () => {
    const check = flaky(Number.MAX_SAFE_INTEGER);
    const { engine, store } = engineWith(LOOPING, {
      impl: doneAfter(IMPL_OUT),
      check: check.executor,
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();
    expect(store.allTerminal()).toBe(true);
  });
});

// The scaffolded spec gate (add-spec-approval-gate): `discuss -> spec ->
// spec-gate -> implement`, with a bare `loopback: true` from `spec-gate` back
// to `discuss`. `loopback: true` normalizes to the same
// `{ maxAttempts: 3, on: 'failure' }` the explicit form above uses; what's
// different here is the trigger — `wasRejectedGate` (engine.ts) reports a
// rejected gate to `fireLoopback` as `failure` even though the node
// completed, so the edge fires on rejection and nothing else.
describe('spec-gate loop-back (add-spec-approval-gate)', () => {
  const SPEC_GATE_YAML = `
nodes:
  - id: discuss
    type: discuss
    config: { topic: x }
  - id: spec
    type: spec
  - id: spec-gate
    type: approval-gate
  - id: implement
    type: implement
    config: { instructions: x }
edges:
  - { from: discuss, to: spec }
  - { from: spec, to: spec-gate }
  - { from: spec-gate, to: implement }
  - { from: spec-gate, to: discuss, loopback: true }
`;
  const SPEC_OUT = {
    specPath: '.flow-code/specs/run.md',
    title: 'T',
    requirements: [],
    acceptanceCriteria: [{ id: 'AC1', text: 'x' }],
  };
  const DISCUSS_OUT = { conclusion: 'ok', constraints: [] };

  /** Rejects on its first call, approves on every call after. */
  function rejectOnceThenApprove(): { executor: NodeExecutor; runs: () => number } {
    let runs = 0;
    return {
      runs: () => runs,
      executor: async function* (): AsyncGenerator<StatusEvent, void, void> {
        runs++;
        yield { type: 'status', status: 'running' };
        const rejected = runs === 1;
        yield {
          type: 'result',
          output: { decision: rejected ? 'rejected' : 'approved', decidedAt: new Date().toISOString() },
        };
        yield { type: 'status', status: 'done', detail: rejected ? 'rejected by user' : 'approved' };
      },
    };
  }

  /** Always rejects — for the maxAttempts-exhaustion case. */
  function alwaysReject(): { executor: NodeExecutor; runs: () => number } {
    let runs = 0;
    return {
      runs: () => runs,
      executor: async function* (): AsyncGenerator<StatusEvent, void, void> {
        runs++;
        yield { type: 'status', status: 'running' };
        yield { type: 'result', output: { decision: 'rejected', decidedAt: new Date().toISOString() } };
        yield { type: 'status', status: 'done', detail: 'rejected by user' };
      },
    };
  }

  it('resets discuss, spec and spec-gate on a rejection, and does not cascade a skip into implement', async () => {
    let discussRuns = 0;
    let specRuns = 0;
    let implementRuns = 0;
    const gate = rejectOnceThenApprove();
    const { engine, store } = engineWith(SPEC_GATE_YAML, {
      discuss: doneAfter(DISCUSS_OUT, async () => {
        discussRuns++;
      }),
      spec: doneAfter(SPEC_OUT, async () => {
        specRuns++;
      }),
      implement: doneAfter(IMPL_OUT, async () => {
        implementRuns++;
      }),
      'spec-gate': gate.executor,
    });
    await engine.run();

    // One rejection, one approval: the segment between spec-gate and its
    // loop-back target ran twice, and implement — outside that segment —
    // ran exactly once, only after approval.
    expect(discussRuns).toBe(2);
    expect(specRuns).toBe(2);
    expect(gate.runs()).toBe(2);
    expect(implementRuns).toBe(1);
    expect(store.attemptOf('discuss')).toBe(2);
    expect(store.attemptOf('spec-gate')).toBe(2);

    // Not cascaded over: a rejected gate is a decision, not a failure, so
    // implement is never touched by markDownstreamSkipped and reaches `done`
    // on the approved pass rather than sitting `skipped`.
    expect(store.node('implement').status).toBe('done');
    expect(store.node('spec-gate').status).toBe('done');
    expect(store.node('spec-gate').output).toMatchObject({ decision: 'approved' });
  });

  it('fires no loop-back, and runs implement once, when the spec gate is approved on the first pass', async () => {
    let discussRuns = 0;
    let implementRuns = 0;
    const { engine, store } = engineWith(SPEC_GATE_YAML, {
      discuss: doneAfter(DISCUSS_OUT, async () => {
        discussRuns++;
      }),
      spec: doneAfter(SPEC_OUT),
      implement: doneAfter(IMPL_OUT, async () => {
        implementRuns++;
      }),
      'spec-gate': doneAfter({ decision: 'approved', decidedAt: new Date().toISOString() }),
    });
    await engine.run();

    expect(discussRuns).toBe(1);
    expect(implementRuns).toBe(1);
    expect(store.attemptOf('discuss')).toBe(1);
    expect(store.node('implement').status).toBe('done');
  });

  it('exhausts after 3 rejections, ending at `done` with the limit named — not `error`', async () => {
    let implementRuns = 0;
    const gate = alwaysReject();
    const { engine, store } = engineWith(SPEC_GATE_YAML, {
      discuss: doneAfter(DISCUSS_OUT),
      spec: doneAfter(SPEC_OUT),
      implement: doneAfter(IMPL_OUT, async () => {
        implementRuns++;
      }),
      'spec-gate': gate.executor,
    });
    await engine.run();

    // maxAttempts 3 counted on the target (discuss): attempts 1, 2, 3, then spent.
    expect(gate.runs()).toBe(3);
    expect(implementRuns).toBe(0);
    // A rejected gate got its answer — it does not fail, so exhausting its
    // loop-back leaves it at `done`, unlike a verification loop-back
    // exhausting at `error`.
    expect(store.node('spec-gate').status).toBe('done');
    expect(store.node('spec-gate').statusDetail).toContain('loop-back attempt limit reached');
    expect(store.node('spec-gate').statusDetail).toContain('`discuss` after 3 attempt(s)');
    expect(store.snapshot().finishedAt).toBeDefined();
  });
});
