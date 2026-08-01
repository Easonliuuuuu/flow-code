import { existsSync } from 'node:fs';
import { git, removeWorktree } from '../git/ops.js';
import { listRunStates } from '../runstate/persist.js';

export interface OrphanedWorktree {
  runId: string;
  nodeId: string;
  instanceId: string;
  branch: string;
  dir: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Worktrees recorded in run-state whose run is no longer alive (crashed or
 * killed mid-run) and whose directory still exists on disk.
 */
export function findOrphanedWorktrees(repoRoot: string): OrphanedWorktree[] {
  const orphans: OrphanedWorktree[] = [];
  for (const state of listRunStates(repoRoot)) {
    const runActive = state.finishedAt === undefined && pidAlive(state.pid);
    if (runActive) continue;
    for (const wt of state.worktrees) {
      if (!wt.removed && existsSync(wt.dir)) {
        orphans.push({
          runId: state.runId,
          nodeId: wt.nodeId,
          instanceId: wt.instanceId,
          branch: wt.branch,
          dir: wt.dir,
        });
      }
    }
  }
  return orphans;
}

export async function removeOrphanedWorktrees(
  repoRoot: string,
  orphans: OrphanedWorktree[],
): Promise<{ removed: string[]; failed: Array<{ dir: string; error: string }> }> {
  const removed: string[] = [];
  const failed: Array<{ dir: string; error: string }> = [];
  for (const orphan of orphans) {
    try {
      await removeWorktree(repoRoot, orphan.dir);
      removed.push(orphan.dir);
    } catch (err) {
      failed.push({ dir: orphan.dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    await git(['worktree', 'prune'], repoRoot);
  } catch {
    // prune is best-effort
  }
  return { removed, failed };
}
