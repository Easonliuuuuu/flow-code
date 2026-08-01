import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { builtinExecutors } from '../src/executors/index.js';
import { recordBaseline } from '../src/git/ops.js';
import type { TestOutput, WorktreeAgentOutput } from '../src/registry/index.js';
import {
  fakePorts,
  fakeSessions,
  makeTempGitRepo,
  storeFor,
  workflowFromYaml,
  type FakePortOptions,
} from './helpers.js';

const COMPARE = `
nodes:
  - id: fan
    type: worktree-agent
    config:
      mode: compare
      task: build the widget
      instances:
        - { id: red, instructions: do it the red way }
        - { id: blue, instructions: do it the blue way }
  - id: after
    type: test
    config: { commands: ["ls"] }
edges:
  - { from: fan, to: after }
`;

const PARALLEL = `
nodes:
  - id: fan
    type: worktree-agent
    config:
      mode: parallelize
      instances:
        - { id: one, task: write file one }
        - { id: two, task: write file two }
  - id: after
    type: test
    config: { commands: ["ls"] }
edges:
  - { from: fan, to: after }
`;

async function runWorktree(
  yaml: string,
  repo: string,
  sessionHandler: Parameters<typeof fakeSessions>[0],
  portOpts: FakePortOptions,
) {
  const workflow = workflowFromYaml(yaml);
  const store = storeFor(workflow, repo);
  const baseline = await recordBaseline(repo, false);
  const ports = fakePorts(portOpts);
  const sessions = fakeSessions(sessionHandler);
  const engine = new Engine({
    workflow,
    store,
    repoRoot: repo,
    baseline,
    ports,
    sessions,
    executors: builtinExecutors,
  });
  await engine.run();
  return { store, ports, sessions };
}

describe('Worktree-Agent node', () => {
  it('compare mode: isolated worktrees, per-instance overrides, single selection wins', async () => {
    const repo = makeTempGitRepo();
    const { store, ports, sessions } = await runWorktree(
      COMPARE,
      repo,
      (req) => {
        writeFileSync(join(req.workingDir, `${req.instanceId}.txt`), `made by ${req.instanceId}\n`);
        return `finished ${req.instanceId}`;
      },
      { select: ['blue'] },
    );

    // Two isolated sessions, each in its own worktree, same base task + own override.
    expect(sessions.requests).toHaveLength(2);
    const dirs = new Set(sessions.requests.map((r) => r.workingDir));
    expect(dirs.size).toBe(2);
    for (const req of sessions.requests) {
      expect(req.workingDir).not.toBe(repo);
      expect(req.prompt).toContain('build the widget');
    }
    expect(sessions.requests.find((r) => r.instanceId === 'red')!.prompt).toContain('red way');
    expect(sessions.requests.find((r) => r.instanceId === 'blue')!.prompt).toContain('blue way');

    // Convergence: both branches presented with diff summaries.
    const conv = ports.convergenceRequests[0]!;
    expect(conv.mode).toBe('compare');
    expect(conv.branches.map((b) => b.instanceId).sort()).toEqual(['blue', 'red']);
    expect(conv.branches.every((b) => b.status === 'done')).toBe(true);
    expect(conv.branches.find((b) => b.instanceId === 'blue')!.diffSummary).toContain('blue.txt');

    // Selected worktree is the downstream working directory and is retained;
    // the non-selected one is removed (its branch kept).
    const output = store.node('fan').output as WorktreeAgentOutput;
    expect(output.selected).toEqual(['blue']);
    expect(existsSync(output.convergedDir)).toBe(true);
    expect(store.node('after').status).toBe('done');
    expect(store.node('after').workingDir).toBe(output.convergedDir);
    const lsOutput = (store.node('after').output as TestOutput).commands[0]!.output;
    expect(lsOutput).toContain('blue.txt');
    expect(lsOutput).not.toContain('red.txt');

    const worktrees = store.snapshot().worktrees;
    expect(worktrees.find((w) => w.instanceId === 'red')!.removed).toBe(true);
    expect(worktrees.find((w) => w.instanceId === 'blue')!.converged).toBe(true);
  });

  it('parallelize mode: selecting several branches merges them into one directory', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runWorktree(
      PARALLEL,
      repo,
      (req) => {
        const name = req.instanceId === 'one' ? 'one.txt' : 'two.txt';
        writeFileSync(join(req.workingDir, name), `content ${req.instanceId}\n`);
        return `finished ${req.instanceId}`;
      },
      { select: ['one', 'two'] },
    );
    expect(store.node('fan').status).toBe('done');
    const output = store.node('fan').output as WorktreeAgentOutput;
    expect(existsSync(join(output.convergedDir, 'one.txt'))).toBe(true);
    expect(existsSync(join(output.convergedDir, 'two.txt'))).toBe(true);
    const lsOutput = (store.node('after').output as TestOutput).commands[0]!.output;
    expect(lsOutput).toContain('one.txt');
    expect(lsOutput).toContain('two.txt');
  });

  it('a merge conflict at convergence fails the node, reports the files, and blocks downstream', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runWorktree(
      PARALLEL,
      repo,
      (req) => {
        // Both instances rewrite the same file with different content.
        writeFileSync(join(req.workingDir, 'README.md'), `rewritten by ${req.instanceId}\n`);
        return `finished ${req.instanceId}`;
      },
      { select: ['one', 'two'] },
    );
    expect(store.node('fan').status).toBe('error');
    expect(store.node('fan').statusDetail).toContain('README.md');
    expect(store.node('after').status).toBe('skipped');
  });

  it('respects the concurrency cap across instance sessions', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
settings:
  concurrency: 1
nodes:
  - id: fan
    type: worktree-agent
    config:
      mode: parallelize
      instances:
        - { id: one, task: a }
        - { id: two, task: b }
        - { id: three, task: c }
`;
    let concurrent = 0;
    let maxConcurrent = 0;
    await runWorktree(
      yaml,
      repo,
      async (req) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 15));
        concurrent--;
        writeFileSync(join(req.workingDir, `${req.instanceId}.txt`), 'x\n');
        return 'ok';
      },
      { select: ['one'] },
    );
    expect(maxConcurrent).toBe(1);
  });

  it('compare mode rejects selecting more than one branch', async () => {
    const repo = makeTempGitRepo();
    const { store } = await runWorktree(
      COMPARE,
      repo,
      (req) => {
        writeFileSync(join(req.workingDir, `${req.instanceId}.txt`), 'x\n');
        return 'ok';
      },
      { select: ['red', 'blue'] },
    );
    expect(store.node('fan').status).toBe('error');
    expect(store.node('fan').statusDetail).toContain('exactly one');
  });
});
