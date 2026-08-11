/**
 * A reported run's only defence against a graph that lies about its own
 * ordering. Every case here is one an engine-driven run cannot reach, because
 * the engine both decides what runs next and records it — these exist only
 * because a reporting agent can say anything.
 */

import { describe, expect, it } from 'vitest';
import type { NodeRunState, RunState } from '../src/runstate/types.js';
import { validateTransition } from '../src/guest/validate.js';
import { recordGraph } from '../src/workflow/record.js';
import { workflowFromYaml } from './helpers.js';

const YAML = `
nodes:
  - id: discuss
    type: discuss
    config: { topic: what to build }
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
  - id: review
    type: review
    config: { instructions: review it }
edges:
  - { from: discuss, to: implement }
  - { from: implement, to: check }
  - { from: check, to: review }
  - { from: check, to: implement, loopback: { maxAttempts: 3 } }
`;

const workflow = workflowFromYaml(YAML);

function node(status: NodeRunState['status'], extra: Partial<NodeRunState> = {}): NodeRunState {
  return { status, denials: 0, ...extra };
}

function stateWith(nodes: Record<string, NodeRunState>): RunState {
  const all: Record<string, NodeRunState> = {};
  for (const n of workflow.nodes) all[n.id] = nodes[n.id] ?? node('idle');
  return {
    runId: 'r1',
    createdAt: '2026-08-11T12:00:00.000Z',
    repoRoot: '/repo',
    pid: 0,
    baseline: null,
    graph: recordGraph(workflow),
    nodes: all,
    worktrees: [],
    activity: [],
  };
}

function reasonFor(state: RunState, reported: Parameters<typeof validateTransition>[2]): string {
  const result = validateTransition(workflow, state, reported);
  if (result.ok) throw new Error('expected a rejection, got an acceptance');
  return result.reason;
}

describe('a node id the workflow does not define', () => {
  it('is rejected, and the rejection lists what the workflow does define', () => {
    const reason = reasonFor(stateWith({}), { nodeId: 'deploy', kind: 'start' });
    expect(reason).toContain('deploy');
    // The list is the difference between an error an agent recovers from and
    // one it can only hand back to a human.
    for (const id of ['discuss', 'implement', 'check', 'review']) expect(reason).toContain(id);
  });
});

describe('ordering', () => {
  it('refuses to start a node whose upstream has not finished, and names it', () => {
    const reason = reasonFor(stateWith({}), { nodeId: 'implement', kind: 'start' });
    expect(reason).toContain('implement');
    expect(reason).toContain('discuss');
    expect(reason).toContain('idle');
  });

  it('accepts a start once every upstream is done', () => {
    const result = validateTransition(
      workflow,
      stateWith({ discuss: node('done') }),
      { nodeId: 'implement', kind: 'start' },
    );
    expect(result).toEqual({ ok: true, accepted: { nodeId: 'implement', status: 'running' } });
  });

  it('treats a branch skipped by a routing condition as satisfied, and one skipped by failure as not', () => {
    const bycondition = validateTransition(
      workflow,
      stateWith({ discuss: node('skipped', { skipReason: 'condition' }) }),
      { nodeId: 'implement', kind: 'start' },
    );
    expect(bycondition.ok).toBe(true);

    const byFailure = validateTransition(
      workflow,
      stateWith({ discuss: node('skipped', { skipReason: 'upstream' }) }),
      { nodeId: 'implement', kind: 'start' },
    );
    expect(byFailure.ok).toBe(false);
  });

  it('refuses to complete a node that never started', () => {
    const reason = reasonFor(stateWith({ discuss: node('done'), implement: node('idle') }), {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: [], diff: '' },
    });
    expect(reason).toContain('cannot complete from `idle`');
  });

  it('refuses to start a node that is already running, or already done', () => {
    expect(reasonFor(stateWith({ discuss: node('running') }), { nodeId: 'discuss', kind: 'start' })).toContain(
      'already running',
    );
    expect(reasonFor(stateWith({ discuss: node('done') }), { nodeId: 'discuss', kind: 'start' })).toContain(
      'already done',
    );
  });

  it('allows restarting a failed node, because a loop-back here is the agent walking back itself', () => {
    const result = validateTransition(
      workflow,
      stateWith({ discuss: node('done'), implement: node('error', { statusDetail: 'broke' }) }),
      { nodeId: 'implement', kind: 'start' },
    );
    expect(result.ok).toBe(true);
  });
});

describe('reported output', () => {
  const ready = stateWith({ discuss: node('done'), implement: node('running') });

  it('is rejected by field when it does not match the node type\'s shape', () => {
    const reason = reasonFor(ready, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: 'src/a.ts' },
    });
    expect(reason).toContain('implement output shape');
    expect(reason).toContain('changedFiles');
  });

  it('is accepted, parsed, when it matches', () => {
    const result = validateTransition(workflow, ready, {
      nodeId: 'implement',
      kind: 'done',
      output: { changedFiles: ['src/a.ts'], diff: '@@' },
    });
    expect(result).toMatchObject({
      ok: true,
      accepted: { nodeId: 'implement', status: 'done', output: { changedFiles: ['src/a.ts'] } },
    });
  });

  it('lands in error when the node type says its own output means failure', () => {
    // A Review reporting `verdict: fail` is a failed node whichever surface
    // reported it — the type owns that question, not the reporter.
    const state = stateWith({
      discuss: node('done'),
      implement: node('done'),
      check: node('done'),
      review: node('running'),
    });
    const result = validateTransition(workflow, state, {
      nodeId: 'review',
      kind: 'done',
      output: { verdict: 'fail', findings: [] },
    });
    expect(result).toMatchObject({ ok: true, accepted: { status: 'error' } });
    if (result.ok) expect(result.accepted.detail).toContain('fail');
  });
});

describe('reported failure', () => {
  it('records the reason as the node\'s status detail', () => {
    const result = validateTransition(
      workflow,
      stateWith({ discuss: node('running') }),
      { nodeId: 'discuss', kind: 'fail', reason: '  the user changed their mind  ' },
    );
    expect(result).toMatchObject({
      ok: true,
      accepted: { status: 'error', detail: 'the user changed their mind' },
    });
  });

  it('is refused without one — a failure nobody explained is not a report', () => {
    expect(
      reasonFor(stateWith({ discuss: node('running') }), { nodeId: 'discuss', kind: 'fail' }),
    ).toContain('reason');
  });
});

describe('walking a loop-back by hand', () => {
  // The graph declares `check → implement` on failure. Nothing routes it in a
  // reported run, so the agent reports the traversal — and the validator has
  // to permit exactly what the generated instructions tell it to do.
  const failed = () =>
    stateWith({
      discuss: node('done'),
      implement: node('done', { attempt: 1 }),
      check: node('error', { statusDetail: 'one test failed', attempt: 1 }),
    });

  it('lets a finished node be re-entered when a failing step returns to it', () => {
    const result = validateTransition(workflow, failed(), { nodeId: 'implement', kind: 'start' });
    expect(result).toMatchObject({ ok: true, accepted: { nodeId: 'implement', status: 'running' } });
  });

  it('resets the segment the loop-back re-runs, so no later step stays done', () => {
    const result = validateTransition(workflow, failed(), { nodeId: 'implement', kind: 'start' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.accepted.reset).toEqual(['check']);
  });

  it('refuses to re-enter a finished node no failing step returns to', () => {
    // `discuss` is done and nothing loops back to it.
    const reason = reasonFor(
      stateWith({ discuss: node('done'), implement: node('error') }),
      { nodeId: 'discuss', kind: 'start' },
    );
    expect(reason).toContain('no failing step declares a return path');
  });

  it('refuses once the failing step has spent its attempts', () => {
    const reason = reasonFor(
      stateWith({
        discuss: node('done'),
        implement: node('done'),
        check: node('error', { attempt: 3 }),
      }),
      { nodeId: 'implement', kind: 'start' },
    );
    // maxAttempts is 3 in this fixture: a fourth pass is the runaway the
    // ceiling exists to stop, and a reported run has nothing else bounding it.
    expect(reason).toContain('all 3 of its attempts');
  });
});
