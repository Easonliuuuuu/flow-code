import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  declaredGraphs,
  loadWorkflow,
  stagesNotEvaluated,
  VALIDATION_STAGE_LABELS,
  WORKFLOW_RELATIVE_PATH,
  WorkflowValidationError,
} from '../workflow/load.js';
import { repoRootFromCwd } from './context.js';

/** Validates one graph (or the flat file, when `graphName` is undefined) and prints its result. */
function reportGraphValidation(repoRoot: string, graphName: string | undefined): boolean {
  const label = graphName !== undefined ? `graph \`${graphName}\`` : WORKFLOW_RELATIVE_PATH;
  try {
    const workflow = loadWorkflow(repoRoot, graphName !== undefined ? { graph: graphName } : {});
    const nodes = workflow.nodes.length;
    const edges = workflow.edges.length;
    console.log(`flow-code: ${label} is valid.`);
    console.log(
      `  ${nodes} node${nodes === 1 ? '' : 's'}, ${edges} edge${edges === 1 ? '' : 's'} — every check passed.`,
    );
    return true;
  } catch (err) {
    if (!(err instanceof WorkflowValidationError)) throw err;
    console.error(`flow-code: ${label} is invalid.`);
    console.error('');
    console.error(`  ${VALIDATION_STAGE_LABELS[err.stage]}:`);
    for (const problem of err.problems) console.error(`    - ${problem}`);

    // Saying which checks never ran is the whole point of staging the loader:
    // a check behind a failure did not pass, and reporting only failures would
    // let someone read silence as a clean bill.
    const skipped = stagesNotEvaluated(err.stage);
    if (skipped.length > 0) {
      console.error('');
      console.error('  Not evaluated (blocked by the failure above):');
      for (const stage of skipped) console.error(`    - ${VALIDATION_STAGE_LABELS[stage]}`);
    }
    return false;
  }
}

/**
 * Checks the workflow file without running it.
 *
 * This deliberately calls the same `loadWorkflow` the run path calls rather
 * than re-implementing the checks: two implementations of "is this valid"
 * drift, and the guarantee worth having is that a file this command accepts
 * cannot then fail a pre-execution check. Sharing the code path makes that
 * true by construction instead of by discipline.
 *
 * A file declaring named graphs is checked one graph at a time, each
 * attributed by name, so a failure in one shape is never mistaken for a
 * failure in another; the file is valid only if every declared graph is.
 *
 * Nothing here starts a session or writes a run document — loading a workflow
 * has no side effects, and the absence of them is what makes this safe to run
 * on a file you are still editing.
 */
export async function cmdValidate(): Promise<void> {
  const repoRoot = await repoRootFromCwd();
  const path = join(repoRoot, WORKFLOW_RELATIVE_PATH);

  // Checked before loading so a missing file reads as "there is nothing here
  // yet" rather than as a syntax problem with a file that does not exist.
  if (!existsSync(path)) {
    console.error(`flow-code: no workflow file at ${path}`);
    console.error('  Run `flow-code init` to scaffold one.');
    process.exit(1);
  }

  const declared = declaredGraphs(repoRoot);
  if (declared === null) {
    if (!reportGraphValidation(repoRoot, undefined)) process.exit(1);
    return;
  }

  console.log(
    `flow-code: ${WORKFLOW_RELATIVE_PATH} declares ${declared.length} named graph${declared.length === 1 ? '' : 's'}.`,
  );
  let allOk = true;
  for (const { name } of declared) {
    console.log('');
    if (!reportGraphValidation(repoRoot, name)) allOk = false;
  }
  if (!allOk) process.exit(1);
}
