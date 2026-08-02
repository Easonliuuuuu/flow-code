export interface OrphanedWorktree {
    runId: string;
    nodeId: string;
    instanceId: string;
    branch: string;
    dir: string;
}
/**
 * Worktrees recorded in run-state whose run is no longer alive (crashed or
 * killed mid-run) and whose directory still exists on disk.
 */
export declare function findOrphanedWorktrees(repoRoot: string): OrphanedWorktree[];
export declare function removeOrphanedWorktrees(repoRoot: string, orphans: OrphanedWorktree[]): Promise<{
    removed: string[];
    failed: Array<{
        dir: string;
        error: string;
    }>;
}>;
