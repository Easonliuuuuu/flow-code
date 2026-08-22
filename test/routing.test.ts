import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import type { ExecuteContext, NodeExecutor, StatusEvent } from '../src/engine/types.js';
import { builtinExecutors } from '../src/executors/index.js';
import type { NodeTypeId } from '../src/registry/index.js';
import type { RunBaseline } from '../src/runstate/types.js';
import { fakePorts, storeFor, throwingSessions, workflowFromYaml } from './helpers.js';

const BASELINE: RunBaseline = { commit: 'c0', tree: 't0', dirtyOverride: false };

function engineWith(yaml: string, fakes: Record<string, NodeExecutor>) {
  const workflow = workflowFromYaml(yaml);
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-routing-'));
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

function doneAfter(output: unknown, body?: (ctx: ExecuteContext) => Promise<void>): NodeExecutor {
  return async function* (ctx): AsyncGenerator<StatusEvent, void, void> {
    yield { type: 'status', status: 'running' };
    if (body) await body(ctx);
    yield { type: 'result', output };
    yield { type: 'status', status: 'done' };
  };
}

const IMPL_OUT = { changedFiles: ['a.ts'], diff: 'd', summary: 's' };
const NO_CHANGES = { changedFiles: [], diff: '', summary: 's' };

/**
 * impl ─┬─▶ rework (only when impl changed something)
 *       └─▶ gate ◀── rework
 *
 * The classic shape conditional edges exist for: one arm is optional, and the
 * node both arms rejoin at must still run either way.
 */
const DIAMOND = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: rework
    type: implement
    config: { instructions: y }
  - id: gate
    type: approval-gate
edges:
  - { from: impl, to: rework, when: "impl.changedFiles isNotEmpty" }
  - { from: impl, to: gate }
  - { from: rework, to: gate }
`;

describe('conditional edges', () => {
  it('runs the guarded branch when its condition holds', async () => {
    const ran: string[] = [];
    const { engine, store } = engineWith(DIAMOND, {
      impl: doneAfter(IMPL_OUT, async () => void ran.push('impl')),
      rework: doneAfter(IMPL_OUT, async () => void ran.push('rework')),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }, async () => void ran.push('gate')),
    });
    await engine.run();
    expect(ran).toEqual(['impl', 'rework', 'gate']);
    expect(store.node('rework').status).toBe('done');
    expect(store.node('gate').status).toBe('done');
  });

  it('skips the guarded branch when it does not, and still reaches the join', async () => {
    const ran: string[] = [];
    const { engine, store } = engineWith(DIAMOND, {
      impl: doneAfter(NO_CHANGES, async () => void ran.push('impl')),
      rework: doneAfter(IMPL_OUT, async () => void ran.push('rework')),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }, async () => void ran.push('gate')),
    });
    await engine.run();

    expect(ran).toEqual(['impl', 'gate']);
    expect(store.node('rework').status).toBe('skipped');
    expect(store.node('rework').skipReason).toBe('condition');
    expect(store.node('rework').statusDetail).toContain('impl.changedFiles isNotEmpty');
    // The branch that was not taken must not take the join down with it.
    expect(store.node('gate').status).toBe('done');
  });

  it('cascades a skip down the branch it belongs to', async () => {
    const CHAIN = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: rework
    type: implement
    config: { instructions: y }
  - id: recheck
    type: review
edges:
  - { from: impl, to: rework, when: "impl.changedFiles isNotEmpty" }
  - { from: rework, to: recheck }
`;
    const { engine, store } = engineWith(CHAIN, {
      impl: doneAfter(NO_CHANGES),
      rework: doneAfter(IMPL_OUT),
      recheck: doneAfter({ verdict: 'pass', findings: [] }),
    });
    await engine.run();

    expect(store.node('rework').status).toBe('skipped');
    expect(store.node('recheck').status).toBe('skipped');
    expect(store.node('recheck').skipReason).toBe('condition');
    expect(store.node('recheck').statusDetail).toContain('branch was not taken');
  });

  it('a failure upstream still blocks the join — only an untaken branch clears it', async () => {
    const { engine, store } = engineWith(DIAMOND, {
      impl: async function* (): AsyncGenerator<StatusEvent, void, void> {
        yield { type: 'status', status: 'running' };
        yield { type: 'status', status: 'error', detail: 'boom' };
      },
      rework: doneAfter(IMPL_OUT),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }),
    });
    await engine.run();

    expect(store.node('impl').status).toBe('error');
    expect(store.node('gate').status).toBe('skipped');
    expect(store.node('gate').skipReason).toBe('upstream');
  });

  it('routes on a node upstream of the edge source, not just the source itself', async () => {
    // The conditional edge sits between rev and gate (gate is ship's sole
    // dominator, satisfying the git-write gate invariant) rather than
    // reaching around the gate to ship directly — its condition still reads
    // impl, upstream of its own source rev, which is what this test is about.
    const UPSTREAM_READ = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: rev
    type: review
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: rev }
  - { from: rev, to: gate, when: "impl.changedFiles isNotEmpty" }
  - { from: gate, to: ship }
`;
    const { engine, store } = engineWith(UPSTREAM_READ, {
      impl: doneAfter(NO_CHANGES),
      rev: doneAfter({ verdict: 'pass', findings: [] }),
      gate: doneAfter({ decision: 'approved', decidedAt: 'now' }),
      ship: doneAfter({ committed: true, pushed: false }),
    });
    await engine.run();

    expect(store.node('rev').status).toBe('done');
    expect(store.node('gate').status).toBe('skipped');
    expect(store.node('ship').status).toBe('skipped');
  });
});

/**
 * impl ──▶ gate ─┬─(approved)─▶ ship
 *                └─(rejected)─▶ revise ──loopback on:success──▶ impl
 *
 * The shape a rejection that *completes* makes possible. `revise` is an
 * ordinary Discuss node placed a second time — node ids are unique, types are
 * not — and it is reached only when the gate was rejected. Its return path is
 * `on: success`: finishing the conversation is the signal to retry, so waiting
 * for it to fail would mean waiting forever.
 */
const REVISION_BRANCH = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: revise
    type: discuss
    config: { topic: what to change }
  - id: ship
    type: implement
    config: { instructions: x }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: ship, when: "gate.decision == 'approved'" }
  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }
  - { from: revise, to: impl, loopback: { maxAttempts: 2, on: success } }
`;

const REVISE_OUT = { conclusion: 'use a different name', constraints: [] };

function gateDeciding(decisions: string[]): NodeExecutor {
  return async function* (): AsyncGenerator<StatusEvent, void, void> {
    yield { type: 'status', status: 'running' };
    yield {
      type: 'result',
      output: { decision: decisions.shift() ?? 'approved', decidedAt: 'now' },
    };
    yield { type: 'status', status: 'done' };
  };
}

describe('a rejection routed through a revision step', () => {
  it('runs the revision step, loops back, and ships on the second decision', async () => {
    const implInputs: string[][] = [];
    let reviseRuns = 0;
    let shipRuns = 0;
    const { engine, store } = engineWith(REVISION_BRANCH, {
      impl: doneAfter(IMPL_OUT, async (ctx) => {
        implInputs.push(ctx.upstream.map((u) => u.nodeId));
      }),
      gate: gateDeciding(['rejected', 'approved']),
      revise: doneAfter(REVISE_OUT, async () => {
        reviseRuns++;
      }),
      ship: doneAfter(IMPL_OUT, async () => {
        shipRuns++;
      }),
    });
    await engine.run();

    expect(reviseRuns).toBe(1);
    expect(shipRuns).toBe(1);
    // The retry carries what the conversation concluded — without it the second
    // pass is the first pass repeated, which is what the loop-back is for.
    expect(implInputs).toHaveLength(2);
    expect(implInputs[1]).toContain('revise');
    expect(store.node('ship').status).toBe('done');
    // `revise` did its pass, then the approved second decision routed around
    // it — so its recorded status is the skip, with the completed run behind it.
    expect(store.node('revise').status).toBe('skipped');
    expect(store.node('revise').priorAttempts?.[0]?.status).toBe('done');
  });

  it('never runs the revision step when the gate is approved first time', async () => {
    let reviseRuns = 0;
    const { engine, store } = engineWith(REVISION_BRANCH, {
      impl: doneAfter(IMPL_OUT),
      gate: gateDeciding(['approved']),
      revise: doneAfter(REVISE_OUT, async () => {
        reviseRuns++;
      }),
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();

    // The cost of the conversation is only paid on a rejection.
    expect(reviseRuns).toBe(0);
    expect(store.node('revise').status).toBe('skipped');
    expect(store.node('revise').skipReason).toBe('condition');
    expect(store.node('ship').status).toBe('done');
  });

  it('stops at the attempt bound instead of revising forever', async () => {
    let shipRuns = 0;
    let reviseRuns = 0;
    const alwaysRejects: NodeExecutor = async function* (): AsyncGenerator<
      StatusEvent,
      void,
      void
    > {
      yield { type: 'status', status: 'running' };
      yield { type: 'result', output: { decision: 'rejected', decidedAt: 'now' } };
      yield { type: 'status', status: 'done' };
    };
    const { engine, store } = engineWith(REVISION_BRANCH, {
      impl: doneAfter(IMPL_OUT),
      gate: alwaysRejects,
      revise: doneAfter(REVISE_OUT, async () => {
        reviseRuns++;
      }),
      ship: doneAfter(IMPL_OUT, async () => {
        shipRuns++;
      }),
    });
    await engine.run();

    // maxAttempts is counted on the target, so `impl` runs twice and the
    // conversation happens twice — then the loop gives up rather than asking
    // the user the same question forever.
    expect(store.node('impl').attempt).toBe(2);
    expect(reviseRuns).toBe(2);
    expect(shipRuns).toBe(0);
    expect(store.node('ship').status).toBe('skipped');
    // A revision step whose return path is spent did its work and delivered it
    // nowhere. Reporting `done` there hides a run that stopped with nothing
    // shipped behind a node that looks like it succeeded.
    expect(store.node('revise').status).toBe('error');
    expect(store.node('revise').statusDetail).toContain('nowhere left to send this back to');
    expect(store.node('revise').statusDetail).toContain('attempt limit reached');
  });

  it('still fires after a verification loop-back has already spent an attempt', async () => {
    // The scaffolded shape: a failure-triggered loop and a success-triggered
    // revision path pointing at the same node, sharing one attempt bound. The
    // bound is counted on the target, so a revision path with a *lower*
    // maxAttempts than the verification loop beside it dies first — one
    // earlier check failure would be enough to hold the whole conversation and
    // then discover it had nowhere to go. Matching them is what prevents that.
    const shared = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
  - id: gate
    type: approval-gate
  - id: revise
    type: discuss
    config: { topic: what to change }
  - id: ship
    type: implement
    config: { instructions: x }
edges:
  - { from: impl, to: check }
  - { from: check, to: gate }
  - { from: gate, to: ship, when: "gate.decision == 'approved'" }
  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }
  - { from: check, to: impl, loopback: { maxAttempts: 3 } }
  - { from: revise, to: impl, loopback: { maxAttempts: 3, on: success } }
`;
    let checkRuns = 0;
    let reviseRuns = 0;
    let shipRuns = 0;
    const { engine, store } = engineWith(shared, {
      impl: doneAfter(IMPL_OUT),
      // Fails once, spending an attempt on `impl` before the gate is reached.
      check: (ctx) =>
        ++checkRuns === 1
          ? (async function* (): AsyncGenerator<StatusEvent, void, void> {
              yield { type: 'status', status: 'running' };
              yield { type: 'status', status: 'error', detail: 'a criterion failed' };
            })()
          : doneAfter({ verdict: 'pass', notes: 'all criteria met' })(ctx),
      gate: gateDeciding(['rejected', 'approved']),
      revise: doneAfter(REVISE_OUT, async () => {
        reviseRuns++;
      }),
      ship: doneAfter(IMPL_OUT, async () => {
        shipRuns++;
      }),
    });
    await engine.run();

    expect(reviseRuns).toBe(1);
    expect(shipRuns).toBe(1);
    expect(store.node('impl').attempt).toBe(3);
    expect(store.node('ship').status).toBe('done');
  });

  it('a success-triggered loop-back does not fire when its source fails', async () => {
    let implRuns = 0;
    const { engine, store } = engineWith(REVISION_BRANCH, {
      impl: doneAfter(IMPL_OUT, async () => {
        implRuns++;
      }),
      gate: gateDeciding(['rejected']),
      revise: async function* (): AsyncGenerator<StatusEvent, void, void> {
        yield { type: 'status', status: 'running' };
        yield { type: 'status', status: 'error', detail: 'conversation broke' };
      },
      ship: doneAfter(IMPL_OUT),
    });
    await engine.run();

    // The return path is declared `on: success`; a failed revise is a failed
    // node, not a reason to retry.
    expect(implRuns).toBe(1);
    expect(store.node('revise').status).toBe('error');
  });
});
