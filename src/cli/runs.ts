import { driverLiveness, listRunStates } from '../runstate/persist.js';
import type { RunState } from '../runstate/types.js';
import { repoRootFromCwd } from './context.js';
import { tallyNodeStatuses } from './run.js';

/**
 * A run with no `finishedAt` is still going, died without a clean exit (ctrl+c
 * handling never ran — `kill -9`, a crashed terminal), or belongs to a machine
 * this one cannot answer for. The third is reported as itself rather than
 * folded into either neighbour, which mirrors `findOrphanedWorktrees`: an
 * unanswerable run is not one whose worktrees are safe to reclaim.
 */
export function runStatusLabel(state: RunState): string {
  if (state.finishedAt !== undefined) return state.interrupted ? 'interrupted' : 'finished';
  switch (driverLiveness(state)) {
    case 'live':
      return 'running';
    case 'dead':
      return 'crashed';
    case 'unknown':
      return 'unknown';
  }
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
    const graphName = state.graph?.selected;
    console.log(
      `  ${state.runId.slice(0, 8)}  ${formatTimestamp(state.createdAt)}  ${runStatusLabel(state).padEnd(11)}` +
        (graphName ? `  (${graphName})` : '') +
        (tally ? `  ${tally}` : ''),
    );
  }
}
