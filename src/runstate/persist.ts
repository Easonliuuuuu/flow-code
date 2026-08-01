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
