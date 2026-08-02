import { existsSync } from 'node:fs';
import { git, removeWorktree } from '../git/ops.js';
import { listRunStates } from '../runstate/persist.js';
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Worktrees recorded in run-state whose run is no longer alive (crashed or
 * killed mid-run) and whose directory still exists on disk.
 */
export function findOrphanedWorktrees(repoRoot) {
    const orphans = [];
    for (const state of listRunStates(repoRoot)) {
        const runActive = state.finishedAt === undefined && pidAlive(state.pid);
        if (runActive)
            continue;
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
export async function removeOrphanedWorktrees(repoRoot, orphans) {
    const removed = [];
    const failed = [];
    for (const orphan of orphans) {
        try {
            await removeWorktree(repoRoot, orphan.dir);
            removed.push(orphan.dir);
        }
        catch (err) {
            failed.push({ dir: orphan.dir, error: err instanceof Error ? err.message : String(err) });
        }
    }
    try {
        await git(['worktree', 'prune'], repoRoot);
    }
    catch {
        // prune is best-effort
    }
    return { removed, failed };
}
//# sourceMappingURL=reconcile.js.map