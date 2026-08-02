import type { StorePersister } from './store.js';
import type { RunState } from './types.js';
export declare function runsDir(repoRoot: string): string;
export declare function runFilePath(repoRoot: string, runId: string): string;
/**
 * Writes the full run-state synchronously on every change (atomic
 * tmp-then-rename), so activity entries written before a crash survive it.
 */
export declare class FileRunStatePersister implements StorePersister {
    private readonly repoRoot;
    constructor(repoRoot: string);
    persist(state: RunState): void;
}
export declare function readRunState(path: string): RunState;
export declare function listRunStates(repoRoot: string): RunState[];
/** Most recently created run that ended via interrupt (ctrl+c/SIGTERM), if any — what `--resume` (no id) targets. */
export declare function findLatestInterruptedRun(repoRoot: string): RunState | undefined;
/** A specific run by id, only if it ended via interrupt — what `--resume <runId>` targets. */
export declare function findInterruptedRun(repoRoot: string, runId: string): RunState | undefined;
