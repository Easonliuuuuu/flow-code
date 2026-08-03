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
    const UPSTREAM_READ = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: rev
    type: review
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: rev }
  - { from: rev, to: ship, when: "impl.changedFiles isNotEmpty" }
`;
    const { engine, store } = engineWith(UPSTREAM_READ, {
      impl: doneAfter(NO_CHANGES),
      rev: doneAfter({ verdict: 'pass', findings: [] }),
      ship: doneAfter({ committed: true, pushed: false }),
    });
    await engine.run();

    expect(store.node('rev').status).toBe('done');
    expect(store.node('ship').status).toBe('skipped');
  });
});
