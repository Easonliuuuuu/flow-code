import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function runsDir(repoRoot) {
    return join(repoRoot, '.flow-code', 'runs');
}
export function runFilePath(repoRoot, runId) {
    return join(runsDir(repoRoot), `${runId}.json`);
}
/**
 * Writes the full run-state synchronously on every change (atomic
 * tmp-then-rename), so activity entries written before a crash survive it.
 */
export class FileRunStatePersister {
    repoRoot;
    constructor(repoRoot) {
        this.repoRoot = repoRoot;
        mkdirSync(runsDir(repoRoot), { recursive: true });
    }
    persist(state) {
        const path = runFilePath(this.repoRoot, state.runId);
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(state, null, 2));
        renameSync(tmp, path);
    }
}
export function readRunState(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
export function listRunStates(repoRoot) {
    let files;
    try {
        files = readdirSync(runsDir(repoRoot)).filter((f) => f.endsWith('.json'));
    }
    catch {
        return [];
    }
    const states = [];
    for (const f of files) {
        try {
            states.push(readRunState(join(runsDir(repoRoot), f)));
        }
        catch {
            // Unreadable run file: skip rather than fail the whole listing.
        }
    }
    return states;
}
/** Most recently created run that ended via interrupt (ctrl+c/SIGTERM), if any — what `--resume` (no id) targets. */
export function findLatestInterruptedRun(repoRoot) {
    return listRunStates(repoRoot)
        .filter((s) => s.interrupted === true)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
/** A specific run by id, only if it ended via interrupt — what `--resume <runId>` targets. */
export function findInterruptedRun(repoRoot, runId) {
    try {
        const state = readRunState(runFilePath(repoRoot, runId));
        return state.interrupted === true ? state : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=persist.js.map