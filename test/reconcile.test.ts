import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunStatePersister } from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import { findOrphanedWorktrees, removeOrphanedWorktrees } from '../src/worktrees/reconcile.js';
import { makeTempGitRepo } from './helpers.js';

function createWorktree(repo: string, name: string): { dir: string; branch: string } {
  const dir = join(repo, '.flow-code', 'worktrees', name);
  const branch = `flow-code/test/${name}`;
  mkdirSync(join(repo, '.flow-code', 'worktrees'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], { cwd: repo });
  return { dir, branch };
}

describe('orphaned-worktree reconciliation', () => {
  it('finds worktrees from dead runs and removes them, keeping live runs alone', async () => {
    const repo = makeTempGitRepo();

    // A "crashed" run: recorded worktree, dead pid, never finished.
    const crashed = new RunStateStore({ repoRoot: repo, nodeIds: ['fan'] });
    crashed.attachPersister(new FileRunStatePersister(repo));
    const wt = createWorktree(repo, 'crashed-one');
    crashed.addWorktree({
      nodeId: 'fan',
      instanceId: 'one',
      branch: wt.branch,
      dir: wt.dir,
      removed: false,
      converged: false,
    });
    // Force a dead pid into the persisted state.
    const snapshot = crashed.snapshot();
    (snapshot as { pid: number }).pid = 999999999;
    new FileRunStatePersister(repo).persist(snapshot);

    // A live run (this process's pid): its worktree must not be flagged.
    const live = new RunStateStore({ repoRoot: repo, nodeIds: ['fan'] });
    live.attachPersister(new FileRunStatePersister(repo));
    const liveWt = createWorktree(repo, 'live-one');
    live.addWorktree({
      nodeId: 'fan',
      instanceId: 'one',
      branch: liveWt.branch,
      dir: liveWt.dir,
      removed: false,
      converged: false,
    });

    const orphans = findOrphanedWorktrees(repo);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.dir).toBe(wt.dir);

    const { removed, failed } = await removeOrphanedWorktrees(repo, orphans);
    expect(failed).toEqual([]);
    expect(removed).toEqual([wt.dir]);
    expect(existsSync(wt.dir)).toBe(false);
    expect(existsSync(liveWt.dir)).toBe(true);
    // The branch (and its work) is kept.
    const branches = execFileSync('git', ['branch', '--list', wt.branch], { cwd: repo }).toString();
    expect(branches).toContain(wt.branch);
  });
});
