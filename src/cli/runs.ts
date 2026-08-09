import { listRunStates, pidAlive } from '../runstate/persist.js';
import type { RunState } from '../runstate/types.js';
import { repoRootFromCwd } from './context.js';
import { tallyNodeStatuses } from './run.js';

/**
 * A run with no `finishedAt` is either still going (its pid is alive) or died
 * without a clean exit (ctrl+c handling never ran — `kill -9`, a crashed
 * terminal). Distinguishing the two mirrors `findOrphanedWorktrees`, which
 * uses the same liveness check to decide whether a run's worktrees are safe
 * to reclaim.
 */
export function runStatusLabel(state: RunState): string {
  if (state.finishedAt === undefined) return pidAlive(state.pid) ? 'running' : 'crashed';
  return state.interrupted ? 'interrupted' : 'finished';
}

/** `2026-08-09T12:34:56.789Z` -> `2026-08-09 12:34:56`, dropping sub-second precision this listing has no use for. */
function formatTimestamp(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

export async function cmdRuns(): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const states = listRunStates(repoRoot).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (states.length === 0) {
    console.log('flow-code: no runs recorded in this repo — start one with `flow-code run`.');
    return;
  }

  console.log(`flow-code: ${states.length} run(s), newest first:`);
  for (const state of states) {
    const tally = tallyNodeStatuses(state.nodes);
    console.log(
      `  ${state.runId.slice(0, 8)}  ${formatTimestamp(state.createdAt)}  ${runStatusLabel(state).padEnd(11)}` +
        (tally ? `  ${tally}` : ''),
    );
  }
}
