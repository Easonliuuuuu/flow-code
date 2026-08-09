import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StorePersister } from './store.js';
import type { RunState } from './types.js';

export function runsDir(repoRoot: string): string {
  return join(repoRoot, '.flow-code', 'runs');
}

export function runFilePath(repoRoot: string, runId: string): string {
  return join(runsDir(repoRoot), `${runId}.json`);
}

/**
 * Writes the full run-state synchronously on every change (atomic
 * tmp-then-rename), so activity entries written before a crash survive it.
 */
export class FileRunStatePersister implements StorePersister {
  constructor(private readonly repoRoot: string) {
    mkdirSync(runsDir(repoRoot), { recursive: true });
  }

  persist(state: RunState): void {
    const path = runFilePath(this.repoRoot, state.runId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  }
}

export function readRunState(path: string): RunState {
  return JSON.parse(readFileSync(path, 'utf8')) as RunState;
}

/** Whether `pid` still belongs to a live process — a run with no `finishedAt` and a dead pid crashed rather than being active. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listRunStates(repoRoot: string): RunState[] {
  let files: string[];
  try {
    files = readdirSync(runsDir(repoRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const states: RunState[] = [];
  for (const f of files) {
    try {
      states.push(readRunState(join(runsDir(repoRoot), f)));
    } catch {
      // Unreadable run file: skip rather than fail the whole listing.
    }
  }
  return states;
}

/** Most recently created run that ended via interrupt (ctrl+c/SIGTERM), if any — what `--resume` (no id) targets. */
export function findLatestInterruptedRun(repoRoot: string): RunState | undefined {
  return listRunStates(repoRoot)
    .filter((s) => s.interrupted === true)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** A specific run by id, only if it ended via interrupt — what `--resume <runId>` targets. */
export function findInterruptedRun(repoRoot: string, runId: string): RunState | undefined {
  try {
    const state = readRunState(runFilePath(repoRoot, runId));
    return state.interrupted === true ? state : undefined;
  } catch {
    return undefined;
  }
}
