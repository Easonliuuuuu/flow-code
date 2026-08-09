import { git } from '../git/ops.js';
import { loadWorkflow, WorkflowValidationError, type Workflow } from '../workflow/load.js';

export function fail(message: string): never {
  console.error(`flow-code: ${message}`);
  process.exit(1);
}

export async function repoRootFromCwd(): Promise<string> {
  try {
    return await git(['rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    fail('not inside a git repository — flow-code runs per-repo.');
  }
}

/** Loads the project's workflow, reporting validation problems as a listing rather than a stack. */
export function loadWorkflowOrFail(repoRoot: string): Workflow {
  try {
    return loadWorkflow(repoRoot);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      console.error('flow-code: the workflow file is invalid:');
      for (const problem of err.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    throw err;
  }
}
