import type { RunBaseline } from '../runstate/types.js';
export declare function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string>;
export declare function headCommit(dir: string): Promise<string>;
export declare function isDirty(dir: string): Promise<boolean>;
/**
 * Snapshot the current working tree (tracked + untracked, respecting
 * excludes) as a tree object, without touching the real index or the tree
 * itself. Uses a temporary index file; blobs land in the object database so
 * later diffs can show content.
 */
export declare function captureTree(dir: string): Promise<string>;
/**
 * Record the run baseline before any node starts. On a clean tree the
 * baseline tree is HEAD's tree; under the dirty override it snapshots the
 * working tree so pre-existing changes never appear as agent output.
 */
export declare function recordBaseline(dir: string, dirtyOverride: boolean): Promise<RunBaseline>;
/** Diff the current working tree of `dir` against a baseline tree. */
export declare function diffAgainstTree(dir: string, tree: string): Promise<string>;
export declare function diffStatAgainstTree(dir: string, tree: string): Promise<string>;
export declare function changedFilesAgainstTree(dir: string, tree: string): Promise<string[]>;
export declare function diffTrees(dir: string, treeA: string, treeB: string): Promise<string>;
export declare function diffNamesBetweenTrees(dir: string, treeA: string, treeB: string): Promise<string[]>;
export declare function diffStatBetweenTrees(dir: string, treeA: string, treeB: string): Promise<string>;
export declare function worktreeSupported(dir: string): Promise<boolean>;
export declare function addWorktree(repoRoot: string, dir: string, branch: string, startPoint: string): Promise<void>;
export declare function removeWorktree(repoRoot: string, dir: string): Promise<void>;
export declare function listWorktreeDirs(repoRoot: string): Promise<string[]>;
/** Commit everything in a worktree as flow-code itself (not agent-driven). */
export declare function commitAll(dir: string, message: string): Promise<string | null>;
