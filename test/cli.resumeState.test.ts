import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInterruptedWorktrees, resolveResumeState } from '../src/cli/run.js';
import { runsDir } from '../src/runstate/persist.js';
import type { RunState } from '../src/runstate/types.js';
import { workflowFromYaml } from './helpers.js';

const WORKFLOW = `
nodes:
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: test
    config: { commands: ["true"] }
`;

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-cli-resume-'));
}

function runState(repoRoot: string, over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-0123456789',
    createdAt: new Date().toISOString(),
    repoRoot,
    pid: process.pid,
    baseline: { commit: 'c'.repeat(40), tree: 't'.repeat(40), dirtyOverride: false },
    nodes: { a: { status: 'done', denials: 0 }, b: { status: 'running', denials: 0 } },
    worktrees: [],
    activity: [],
    interrupted: true,
    ...over,
  };
}

/** Writes `state` where `findInterruptedRun`/`findLatestInterruptedRun` look for it. */
function writeRun(repoRoot: string, state: RunState): void {
  mkdirSync(runsDir(repoRoot), { recursive: true });
  writeFileSync(join(runsDir(repoRoot), `${state.runId}.json`), JSON.stringify(state));
}

/** Makes `fail`'s process.exit observable rather than killing the test runner. */
function trapExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exit, error };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveResumeState', () => {
  it('returns the named interrupted run', () => {
    const repo = tempRepo();
    writeRun(repo, runState(repo));
    const state = resolveResumeState(repo, workflowFromYaml(WORKFLOW), 'run-0123456789');
    expect(state.runId).toBe('run-0123456789');
  });

  it('falls back to the most recent interrupted run when given no id', () => {
    const repo = tempRepo();
    writeRun(repo, runState(repo, { runId: 'older', createdAt: '2020-01-01T00:00:00.000Z' }));
    writeRun(repo, runState(repo, { runId: 'newer', createdAt: '2030-01-01T00:00:00.000Z' }));
    expect(resolveResumeState(repo, workflowFromYaml(WORKFLOW)).runId).toBe('newer');
  });

  it('exits when no interrupted run exists at all', () => {
    const repo = tempRepo();
    const { error } = trapExit();
    expect(() => resolveResumeState(repo, workflowFromYaml(WORKFLOW))).toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no interrupted run found'));
  });

  it('names the run that could not be found when given an explicit id', () => {
    const repo = tempRepo();
    const { error } = trapExit();
    expect(() => resolveResumeState(repo, workflowFromYaml(WORKFLOW), 'nope')).toThrow(
      'process.exit called',
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('`nope`'));
  });

  it('refuses a run whose nodes the workflow no longer has', () => {
    const repo = tempRepo();
    writeRun(
      repo,
      runState(repo, { nodes: { a: { status: 'done', denials: 0 }, gone: { status: 'idle', denials: 0 } } }),
    );
    const { error } = trapExit();
    expect(() => resolveResumeState(repo, workflowFromYaml(WORKFLOW))).toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('missing node(s): gone'));
  });

  it('refuses a run with no recorded baseline to diff against', () => {
    const repo = tempRepo();
    writeRun(repo, runState(repo, { baseline: null }));
    const { error } = trapExit();
    expect(() => resolveResumeState(repo, workflowFromYaml(WORKFLOW))).toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no recorded baseline'));
  });

  it('ignores a run that ended normally rather than by interrupt', () => {
    const repo = tempRepo();
    writeRun(repo, runState(repo, { interrupted: false }));
    const { error } = trapExit();
    expect(() => resolveResumeState(repo, workflowFromYaml(WORKFLOW))).toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no interrupted run found'));
  });
});

/** A real repo with one commit — `git worktree`/`git branch` need genuine history. */
function gitRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-cli-resume-git-'));
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'test']);
  writeFileSync(join(repoRoot, 'README.md'), 'seed\n');
  run(['add', '-A']);
  run(['commit', '-m', 'seed']);
  return repoRoot;
}

describe('resetInterruptedWorktrees', () => {
  it('clears the worktree and branch of a node that did not finish', async () => {
    const repo = gitRepo();
    const dir = join(repo, '.flow-code', 'worktrees', 'b');
    execFileSync('git', ['worktree', 'add', '-b', 'flow/b', dir], { cwd: repo, stdio: 'ignore' });
    expect(existsSync(dir)).toBe(true);

    const state = runState(repo, {
      worktrees: [{ nodeId: 'b', instanceId: 'b#1', branch: 'flow/b', dir, removed: false, converged: false }],
    });
    await resetInterruptedWorktrees(repo, state);

    expect(existsSync(dir)).toBe(false);
    expect(state.worktrees[0]!.removed).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', 'flow/b'], { cwd: repo, encoding: 'utf8' });
    expect(branches.trim()).toBe('');
  });

  it("leaves a completed node's worktree alone", async () => {
    const repo = gitRepo();
    const dir = join(repo, '.flow-code', 'worktrees', 'a');
    execFileSync('git', ['worktree', 'add', '-b', 'flow/a', dir], { cwd: repo, stdio: 'ignore' });

    const state = runState(repo, {
      worktrees: [{ nodeId: 'a', instanceId: 'a#1', branch: 'flow/a', dir, removed: false, converged: false }],
    });
    await resetInterruptedWorktrees(repo, state);

    expect(existsSync(dir)).toBe(true);
    expect(state.worktrees[0]!.removed).toBe(false);
  });

  it('skips a worktree already marked removed, and tolerates a directory that is gone', async () => {
    const repo = gitRepo();
    const state = runState(repo, {
      worktrees: [
        {
          nodeId: 'b',
          instanceId: 'b#1',
          branch: 'flow/already',
          dir: join(repo, 'never-existed'),
          removed: true,
          converged: false,
        },
        {
          nodeId: 'b',
          instanceId: 'b#2',
          branch: 'flow/vanished',
          dir: join(repo, 'also-gone'),
          removed: false,
          converged: false,
        },
      ],
    });

    await expect(resetInterruptedWorktrees(repo, state)).resolves.toBeUndefined();
    expect(state.worktrees[0]!.removed).toBe(true);
    // The directory was already gone, but the record is still reconciled so the
    // retry doesn't collide with the branch the interrupted attempt created.
    expect(state.worktrees[1]!.removed).toBe(true);
  });
});
