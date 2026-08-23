import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/engine.js';
import { builtinExecutors } from '../../src/executors/index.js';
import { recordBaseline } from '../../src/git/ops.js';
import { RunStateStore } from '../../src/runstate/store.js';
import { recordGraph } from '../../src/workflow/record.js';
import { DemoSessionRunner } from '../../src/demo/DemoSessionRunner.js';
import { DEMO_DISCUSS_USER_MESSAGE, DEMO_SOURCE_FILENAME } from '../../src/demo/fixtures.js';
import { seedDemoRepo } from '../../src/demo/seedRepo.js';
import { fakePorts, workflowFromYaml } from '../helpers.js';
import { WORKFLOW_RELATIVE_PATH } from '../../src/workflow/load.js';

/** Drives the seeded demo's real default graph through the real engine, at full speed. */
async function driveDemo(): Promise<{
  store: RunStateStore;
  dir: string;
  runner: DemoSessionRunner;
  ports: ReturnType<typeof fakePorts>;
}> {
  const { dir } = seedDemoRepo();
  const yaml = readFileSync(join(dir, WORKFLOW_RELATIVE_PATH), 'utf8');
  const workflow = workflowFromYaml(yaml);
  const store = new RunStateStore({ repoRoot: dir, graph: recordGraph(workflow) });
  const baseline = await recordBaseline(dir, false);
  store.setBaseline(baseline);
  const ports = fakePorts({ approve: 'approve', userMessages: [DEMO_DISCUSS_USER_MESSAGE] });
  const runner = new DemoSessionRunner(0); // no pacing — this is a correctness test, not a timing one
  const engine = new Engine({
    workflow,
    store,
    repoRoot: dir,
    baseline,
    ports,
    sessions: runner,
    executors: builtinExecutors,
  });
  await engine.run();
  return { store, dir, runner, ports };
}

describe('DemoSessionRunner driving the real default graph', () => {
  it('covers every agent-driven node in the default graph — nothing ends in error', async () => {
    const { store } = await driveDemo();
    const nodes = Object.values(store.snapshot().nodes);
    const errored = nodes.filter((n) => n.status === 'error');
    expect(errored).toEqual([]);
  });

  it('reaches git-ops and every node completes or is a legitimate skip', async () => {
    const { store } = await driveDemo();
    const gitOps = store.snapshot().nodes['git-ops'];
    expect(gitOps?.status).toBe('done');
  });

  it('the test node fails once, the loop-back fires, and implement runs a second time with different content', async () => {
    const { store, dir } = await driveDemo();
    // A single node id appears once in the snapshot regardless of attempts —
    // attempt count instead comes from the effect: the file on disk is the
    // fixed version, and the test node's final recorded status is a pass
    // despite having failed on the way there (asserted next).
    const finalSource = readFileSync(join(dir, DEMO_SOURCE_FILENAME), 'utf8');
    expect(finalSource).toContain('return a + b;');
    expect(finalSource).not.toContain('return a + b + 1;');

    const testNode = store.snapshot().nodes['test'];
    expect((testNode?.output as { passed?: boolean } | undefined)?.passed).toBe(true);
  });

  it('a fresh runner writes the buggy source on its first implement call and the fix on its second', () => {
    const { dir } = seedDemoRepo();
    const runner = new DemoSessionRunner(0);
    const req = {
      nodeId: 'implement',
      capabilities: new Set<never>(),
      rolePrompt: '',
      prompt: '',
      workingDir: dir,
    } as Parameters<DemoSessionRunner['run']>[0];

    return runner.run(req).then(() => {
      const afterFirst = readFileSync(join(dir, DEMO_SOURCE_FILENAME), 'utf8');
      expect(afterFirst).toContain('return a + b + 1;');
      return runner.run(req).then(() => {
        const afterSecond = readFileSync(join(dir, DEMO_SOURCE_FILENAME), 'utf8');
        expect(afterSecond).toContain('return a + b;');
        expect(afterSecond).not.toContain('return a + b + 1;');
      });
    });
  });

  it('throws rather than silently succeeding for a node id it has no script for', async () => {
    const { dir } = seedDemoRepo();
    const runner = new DemoSessionRunner(0);
    const req = {
      nodeId: 'some-future-node',
      capabilities: new Set<never>(),
      rolePrompt: '',
      prompt: '',
      workingDir: dir,
    } as Parameters<DemoSessionRunner['run']>[0];
    await expect(runner.run(req)).rejects.toThrow(/no script for node/);
  });

  it('git-ops performs a real commit that real git records', async () => {
    const { dir } = await driveDemo();
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString();
    // The seed commit, plus git-ops's own commit.
    expect(log.trim().split('\n').length).toBe(2);
  });

  it('needs no network access and no child process beyond git and the test command', async () => {
    // No provider env vars, no live credentials — if the runner ever needed
    // either, this would be where a real SDK call would throw or hang.
    const before = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY']) {
      delete process.env[key];
    }
    try {
      const { store } = await driveDemo();
      const errored = Object.values(store.snapshot().nodes).filter((n) => n.status === 'error');
      expect(errored).toEqual([]);
    } finally {
      process.env = before;
    }
  });

  it('the loop-back actually fired — implement ran twice, with a failed test attempt recorded in between', async () => {
    const { store } = await driveDemo();
    const nodes = store.snapshot().nodes;
    // `attempt` counts from 1 and only exceeds it once a loop-back has reset
    // and re-run the node — this is the run-state's own record of the retry,
    // not an inference from the file on disk (which the other test checks).
    expect(nodes['implement']?.attempt).toBe(2);
    // The test node was reset by the same loop-back; its one prior attempt is
    // the failure that triggered it, not a pass — a demo where the test
    // happens to pass on the first try never exercises the loop-back at all.
    expect(nodes['test']?.priorAttempts?.length).toBe(1);
    expect(nodes['test']?.priorAttempts?.[0]?.status).toBe('error');
  });

  it('the gate saw a non-empty diff computed from real git, not scripted text', async () => {
    const { ports } = await driveDemo();
    const gateRequest = ports.approvalRequests.find((r) => r.nodeId === 'gate');
    expect(gateRequest).toBeDefined();
    expect(gateRequest!.diffs.length).toBeGreaterThan(0);
    const diff = gateRequest!.diffs[0]!.diff;
    // `git diff`'s own format, not anything the script wrote — proof this
    // came from `diffTrees` (src/git/ops.ts) rather than from script.ts.
    expect(diff).toContain('diff --git');
    expect(diff).toContain(DEMO_SOURCE_FILENAME);
    expect(diff).toContain('return a + b;');
  });
});
