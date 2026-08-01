import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { builtinExecutors } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import type { TestOutput, ApprovalGateOutput } from '../src/registry/index.js';
import {
  fakePorts,
  fakeSessions,
  makeTempGitRepo,
  storeFor,
  throwingSessions,
  workflowFromYaml,
} from './helpers.js';
import type { FakePortOptions } from './helpers.js';

async function runReal(
  yaml: string,
  repo: string,
  opts: {
    ports?: ReturnType<typeof fakePorts>;
    sessions?: ReturnType<typeof fakeSessions>;
    portOpts?: FakePortOptions;
  } = {},
) {
  const workflow = workflowFromYaml(yaml);
  const store = storeFor(workflow, repo);
  const baseline = await recordBaseline(repo, false);
  const ports = opts.ports ?? fakePorts(opts.portOpts ?? {});
  const engine = new Engine({
    workflow,
    store,
    repoRoot: repo,
    baseline,
    ports,
    sessions: opts.sessions ?? (throwingSessions() as never),
    executors: builtinExecutors,
  });
  await engine.run();
  return { store, ports, workflow, baseline };
}

describe('Test node (deterministic command runner)', () => {
  it('runs commands in order, records results, and consumes no agent session', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands:
        - echo first
        - echo second
`,
      repo,
    );
    expect(store.node('t').status).toBe('done');
    const output = store.node('t').output as TestOutput;
    expect(output.passed).toBe(true);
    expect(output.commands.map((c) => c.exitStatus)).toEqual([0, 0]);
    expect(output.commands[0]!.output).toContain('first');
    const activity = store.activityFor('t');
    expect(activity).toHaveLength(2);
    expect(activity.every((e) => e.decision === 'allowed' && e.exitStatus === 0)).toBe(true);
  });

  it('errors on a failing command, identifying it and its exit status, and skips downstream', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runReal(
      `
nodes:
  - id: t
    type: test
    config:
      commands:
        - echo before
        - exit 7
        - echo never
  - id: after
    type: test
    config: { commands: ["echo x"] }
edges:
  - { from: t, to: after }
`,
      repo,
    );
    expect(store.node('t').status).toBe('error');
    expect(store.node('t').statusDetail).toContain('exit 7');
    const output = store.node('t').output as TestOutput;
    expect(output.passed).toBe(false);
    expect(output.commands).toHaveLength(2);
    expect(output.commands[1]!.exitStatus).toBe(7);
    expect(store.node('after').status).toBe('skipped');
  });
});

describe('Approval-Gate node', () => {
  const GATED = `
nodes:
  - id: impl
    type: implement
    config: { instructions: write a file }
  - id: gate
    type: approval-gate
  - id: after
    type: test
    config: { commands: ["echo ran"] }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: after }
`;

  function implSessions(_repo: string) {
    return fakeSessions((req) => {
      writeFileSync(join(req.workingDir, 'agent-made.txt'), 'agent content\n');
      return 'done: wrote agent-made.txt';
    });
  }

  it('shows the diff against the run baseline and unblocks downstream on approval', async () => {
    const repo = makeTempGitRepo();
    const { store, ports } = await runReal(GATED, repo, {
      sessions: implSessions(repo),
      portOpts: { approve: 'approve' },
    });
    expect(ports.approvalRequests).toHaveLength(1);
    const req = ports.approvalRequests[0]!;
    expect(req.diffs[0]!.diff).toContain('agent-made.txt');
    expect(req.diffs[0]!.diff).toContain('agent content');
    expect(req.upstreamSummaries.map((u) => u.nodeId)).toEqual(['impl']);
    expect(store.node('gate').status).toBe('done');
    expect((store.node('gate').output as ApprovalGateOutput).decision).toBe('approved');
    expect(store.node('after').status).toBe('done');
  });

  it('on reject: gate errors, downstream is skipped, independent branches still run', async () => {
    const repo = makeTempGitRepo();
    // Independent branch: `solo` depends only on impl, not on the gate.
    const withIndependent = `
nodes:
  - id: impl
    type: implement
    config: { instructions: write a file }
  - id: gate
    type: approval-gate
  - id: after
    type: test
    config: { commands: ["echo ran"] }
  - id: solo
    type: test
    config: { commands: ["echo independent"] }
edges:
  - { from: impl, to: gate }
  - { from: gate, to: after }
  - { from: impl, to: solo }
`;
    const { store } = await runReal(withIndependent, repo, {
      sessions: implSessions(repo),
      portOpts: { approve: 'reject' },
    });
    expect(store.node('gate').status).toBe('error');
    expect(store.node('gate').statusDetail).toContain('rejected');
    expect((store.node('gate').output as ApprovalGateOutput).decision).toBe('rejected');
    expect(store.node('after').status).toBe('skipped');
    expect(store.node('solo').status).toBe('done');
  });

  it('surfaces the push target when a push-configured Git-ops node is downstream', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
    config:
      push: { remote: origin, branch: main }
edges:
  - { from: gate, to: ship }
`;
    const { ports } = await runReal(yaml, repo, {
      sessions: fakeSessions(() => 'ok'),
      portOpts: { approve: 'reject' },
    });
    expect(ports.approvalRequests[0]!.pushTarget).toEqual({
      nodeId: 'ship',
      remote: 'origin',
      branch: 'main',
    });
  });

  it('under the dirty-tree override, pre-existing changes never appear in the gate diff', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'user-wip.txt'), 'user work in progress\n');
    const workflow = workflowFromYaml(GATED);
    const store = storeFor(workflow, repo);
    const baseline = await recordBaseline(repo, true);
    const ports = fakePorts({ approve: 'approve' });
    const engine = new Engine({
      workflow,
      store,
      repoRoot: repo,
      baseline,
      ports,
      sessions: implSessions(repo),
      executors: builtinExecutors,
    });
    await engine.run();
    const diff = ports.approvalRequests[0]!.diffs[0]!.diff;
    expect(diff).toContain('agent-made.txt');
    expect(diff).not.toContain('user-wip');
  });
});
