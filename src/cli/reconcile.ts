/**
 * `flow-code reconcile` — ask the repository whether a run's claims are true.
 *
 * Deliberately a command you run rather than something that happens on every
 * transition. Comparing trees costs a `git diff` over the whole working tree,
 * which is not a price to pay on each report; and the answer is only meaningful
 * once a node has actually finished, so continuous checking would mostly
 * produce findings about work still in progress.
 */

import { existsSync } from 'node:fs';
import {
  formatReport,
  reconcileRun,
  reportPath,
  writeReport,
  type ReconcileReport,
} from '../guest/reconcile.js';
import { listRunStates, readRunState, runFilePath } from '../runstate/persist.js';
import type { RunState } from '../runstate/types.js';
import { latestRunState } from '../runstate/watch.js';
import { RecordedGraphError, rehydrateGraph } from '../workflow/record.js';
import { fail, repoRootFromCwd } from './context.js';

function resolveRun(repoRoot: string, runId: string | undefined): RunState {
  if (runId === undefined) {
    const latest = latestRunState(repoRoot);
    if (!latest) fail('no runs in this repository yet.');
    return latest;
  }
  const exact = runFilePath(repoRoot, runId);
  if (existsSync(exact)) return readRunState(exact);
  const found = listRunStates(repoRoot).find((s) => s.runId.startsWith(runId));
  if (!found) fail(`no run \`${runId}\` in this repository.`);
  return found;
}

export async function cmdReconcile(args: string[]): Promise<void> {
  const runId = args.find((a) => !a.startsWith('-'));
  const repoRoot = await repoRootFromCwd();
  const state = resolveRun(repoRoot, runId);

  if (!state.graph) {
    fail(`run ${state.runId.slice(0, 8)} recorded no graph — there is nothing to reconcile it against.`);
  }
  let report: ReconcileReport;
  try {
    report = await reconcileRun(repoRoot, state, rehydrateGraph(state.graph, { repoRoot }));
  } catch (err) {
    if (err instanceof RecordedGraphError) fail(err.message);
    throw err;
  }

  // Written so a viewer attached to this run can show the findings without
  // running git itself — and beside the run document, never into it.
  writeReport(repoRoot, report);

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
    console.log(`\n  report written to ${reportPath(repoRoot, report.runId)}`);
  }

  // Non-zero when the repository contradicts the run, so this is usable as a
  // check rather than only as a thing to read. An unreconcilable run is not a
  // contradiction — it is an absence of evidence — and exits zero.
  if (report.findings.length > 0) process.exit(1);
}
