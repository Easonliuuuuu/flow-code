import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import type { ExecuteContext, NodeExecutor, StatusEvent } from '../src/engine/types.js';
import { RunInterruptedError } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import type { NodeTypeId } from '../src/registry/index.js';
import type { RunBaseline } from '../src/runstate/types.js';
import { fakePorts, storeFor, throwingSessions, workflowFromYaml } from './helpers.js';

const BASELINE: RunBaseline = { commit: 'c0', tree: 't0', dirtyOverride: false };

function engineWith(yaml: string, fakes: Record<string, NodeExecutor>) {
  const workflow = workflowFromYaml(yaml);
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-budget-'));
  const store = storeFor(workflow, repoRoot);
  const dispatch: NodeExecutor = (ctx) => {
    const fake = fakes[ctx.node.id];
    if (!fake) throw new Error(`no fake executor for node ${ctx.node.id}`);
    return fake(ctx);
  };
  const executors = Object.fromEntries(
    Object.keys(builtinExecutors).map((k) => [k, dispatch]),
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
  return { engine, store };
}

const IMPL_OUT = { changedFiles: ['a.ts'], diff: 'd', summary: 's' };

function doneAfter(output: unknown, body?: (ctx: ExecuteContext) => Promise<void>): NodeExecutor {
  return async function* (ctx): AsyncGenerator<StatusEvent, void, void> {
    yield { type: 'status', status: 'running' };
    if (body) await body(ctx);
    yield { type: 'result', output };
    yield { type: 'status', status: 'done' };
  };
}

/**
 * A node that keeps spending until something stops it — the shape a runaway
 * agent loop has, and the only thing a stop rule is really tested against.
 */
function spendsUntilAborted(perTick: number): NodeExecutor {
  return async function* (ctx): AsyncGenerator<StatusEvent, void, void> {
    yield { type: 'status', status: 'running' };
    for (let i = 0; i < 1000; i++) {
      if (ctx.signal.aborted) throw new RunInterruptedError();
      ctx.store.addTokens(ctx.node.id, { input: perTick, output: 0, cached: 0 });
      await new Promise((r) => setTimeout(r, 1));
    }
    yield { type: 'result', output: IMPL_OUT };
    yield { type: 'status', status: 'done' };
  };
}

const CHAIN = (budget: string): string => `
settings:
${budget}
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: y }
edges:
  - { from: a, to: b }
`;

describe('budgets as stop rules', () => {
  it('stops a node that exceeds its own token budget, and says why', async () => {
    const { engine, store } = engineWith(CHAIN('  budget: { tokensPerNode: 500 }'), {
      a: spendsUntilAborted(100),
      b: doneAfter(IMPL_OUT),
    });
    await engine.run();

    expect(store.node('a').status).toBe('error');
    expect(store.node('a').statusDetail).toContain('node token budget exhausted');
    expect(store.tokensFor('a')).toBeGreaterThan(500);
    // A node that overspent takes its own branch down; the run still ends.
    expect(store.node('b').status).toBe('skipped');
    expect(store.snapshot().finishedAt).toBeDefined();
  });

  it('leaves a node under its budget completely alone', async () => {
    const { engine, store } = engineWith(CHAIN('  budget: { tokensPerNode: 10000 }'), {
      a: doneAfter(IMPL_OUT, async (ctx) => {
        ctx.store.addTokens('a', { input: 900, output: 100, cached: 0 });
      }),
      b: doneAfter(IMPL_OUT),
    });
    await engine.run();

    expect(store.node('a').status).toBe('done');
    expect(store.node('b').status).toBe('done');
  });

  it("enforces a node's own budget with no run-wide budget declared at all", async () => {
    const PER_NODE = `
nodes:
  - id: a
    type: implement
    budget: { tokens: 500 }
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: y }
edges:
  - { from: a, to: b }
`;
    const { engine, store } = engineWith(PER_NODE, {
      a: spendsUntilAborted(100),
      b: doneAfter(IMPL_OUT),
    });
    await engine.run();

    expect(store.node('a').status).toBe('error');
    expect(store.node('a').statusDetail).toContain('node token budget exhausted');
    expect(store.tokensFor('a')).toBeGreaterThan(500);
  });

  it("lets a node's own budget overrule the run-wide one, tighter or looser", async () => {
    // `a` is held to its own 500 despite the run-wide 100000; `b` is allowed
    // its own 100000 despite the run-wide 500 — the override wins in both
    // directions, not just the more cautious one.
    const OVERRIDES = `
settings:
  budget: { tokensPerNode: 500 }
nodes:
  - id: a
    type: implement
    budget: { tokens: 100000 }
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: y }
edges:
  - { from: a, to: b }
`;
    const { engine, store } = engineWith(OVERRIDES, {
      a: doneAfter(IMPL_OUT, async (ctx) => {
        ctx.store.addTokens('a', { input: 5_000, output: 0, cached: 0 });
      }),
      b: spendsUntilAborted(100),
    });
    await engine.run();

    // Well past the run-wide 500, and untouched.
    expect(store.node('a').status).toBe('done');
    expect(store.tokensFor('a')).toBe(5_000);
    // No budget of its own, so it inherits the run-wide ceiling and trips it.
    expect(store.node('b').status).toBe('error');
    expect(store.node('b').statusDetail).toContain('node token budget exhausted');
  });

  it('stops the whole run once the run-wide token budget is spent', async () => {
    const { engine, store } = engineWith(CHAIN('  budget: { tokensPerRun: 400 }'), {
      a: spendsUntilAborted(100),
      b: doneAfter(IMPL_OUT),
    });
    await engine.run();

    expect(store.node('a').status).toBe('error');
    expect(store.node('a').statusDetail).toContain('run token budget exhausted');
    expect(store.node('b').status).toBe('skipped');
    expect(store.node('b').statusDetail).toContain('run token budget exhausted');
  });

  it('never retries past a ceiling, even with a loop-back that would otherwise fire', async () => {
    const LOOPING = `
settings:
  budget: { tokensPerNode: 300 }
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
edges:
  - { from: impl, to: check }
  - { from: check, to: impl, loopback: { maxAttempts: 3 } }
`;
    let implRuns = 0;
    const { engine, store } = engineWith(LOOPING, {
      impl: (ctx) => {
        implRuns++;
        return spendsUntilAborted(100)(ctx);
      },
      check: doneAfter({ verdict: 'pass', notes: 'n', criteria: [] }),
    });
    await engine.run();

    // Retrying past a ceiling is exactly what the ceiling exists to prevent.
    expect(implRuns).toBe(1);
    expect(store.attemptOf('impl')).toBe(1);
    expect(store.node('impl').status).toBe('error');
    expect(store.node('impl').statusDetail).toContain('budget exhausted');
  });

  it('does nothing at all when no budget is configured', async () => {
    const { engine, store } = engineWith('nodes:\n  - id: a\n    type: implement\n    config: { instructions: x }', {
      a: doneAfter(IMPL_OUT, async (ctx) => {
        ctx.store.addTokens('a', { input: 10_000_000, output: 0, cached: 0 });
      }),
    });
    await engine.run();
    expect(store.node('a').status).toBe('done');
  });
});
