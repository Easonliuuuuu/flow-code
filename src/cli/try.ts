import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordBaseline } from '../git/ops.js';
import { DemoInteractionPorts } from '../demo/DemoInteractionPorts.js';
import { DemoSessionRunner } from '../demo/DemoSessionRunner.js';
import { seedDemoRepo } from '../demo/seedRepo.js';
import { Notifier } from '../notify/index.js';
import { FileRunStatePersister } from '../runstate/persist.js';
import { RunStateStore } from '../runstate/store.js';
import { WORKFLOW_RELATIVE_PATH, loadWorkflowFromString } from '../workflow/load.js';
import { recordGraph } from '../workflow/record.js';
import { resolveNotificationConfig } from './args.js';
import { fail } from './context.js';
import { makeInterruptTrigger, runEngineUi } from './run.js';

/**
 * `flow-code try`: the same default graph a real `flow-code init` scaffolds,
 * run end to end against a seeded temporary repository, with every agent
 * session scripted rather than live. No repository, configuration, or
 * credential is required — see `openspec/changes/add-first-run-demo`.
 *
 * Deliberately not `run.ts`'s full `cmdRun`: no resume, no provider
 * resolution, no dirty-tree handling, and no preflight — none of it applies
 * to a repository this command creates itself, clean, with no agent-driven
 * node needing real credentials. What *is* shared is the part that actually
 * runs a workflow — `runEngineUi`, the same function `cmdRun` calls — so the
 * demo drives the identical engine and UI a real run does.
 */
export async function cmdTry(): Promise<void> {
  // Both the spec-gate and the git gate block on a real approval — see
  // design.md — so a non-interactive invocation would hang forever rather
  // than demonstrate anything. Checked before anything is created.
  if (!process.stdin.isTTY) {
    fail(
      'flow-code try needs an interactive terminal — it pauses for a real approval at two points ' +
        'in the demo, the same as `flow-code run` does, and there is no one to ask.',
    );
  }

  const { dir } = seedDemoRepo();
  const workflowPath = join(dir, WORKFLOW_RELATIVE_PATH);
  const workflow = loadWorkflowFromString(readFileSync(workflowPath, 'utf8'), { repoRoot: dir });

  const store = new RunStateStore({ repoRoot: dir, graph: recordGraph(workflow) });
  store.attachPersister(new FileRunStatePersister(dir));
  const baseline = await recordBaseline(dir, false);
  store.setBaseline(baseline);

  const notifier = new Notifier(resolveNotificationConfig([], process.env, workflow.settings.notifications));
  const abortController = new AbortController();
  const ports = new DemoInteractionPorts(abortController.signal, notifier);
  const sessions = new DemoSessionRunner();
  const triggerInterrupt = makeInterruptTrigger(abortController);
  process.on('SIGINT', triggerInterrupt);
  process.on('SIGTERM', triggerInterrupt);

  await runEngineUi({
    workflow,
    store,
    repoRoot: dir,
    baseline,
    ports,
    sessions,
    signal: abortController.signal,
    onInterrupt: triggerInterrupt,
    splash: false,
    modelContext: { providerId: undefined, providerDefaultModel: undefined, workflowSettingsModel: undefined },
    demo: true,
  });
  process.off('SIGINT', triggerInterrupt);
  process.off('SIGTERM', triggerInterrupt);

  console.log('\nflow-code: demo complete.\n');
  console.log(`  Repo:  ${dir}`);
  console.log(`  Graph: ${workflowPath}`);
  console.log('\n  Try it on your own project:');
  console.log('    flow-code init');
  process.exit(0);
}
