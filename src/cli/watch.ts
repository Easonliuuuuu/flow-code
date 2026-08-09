import { existsSync } from 'node:fs';
import { loadCredentials } from '../engine/credentials.js';
import { runFilePath } from '../runstate/persist.js';
import { RunStateStore } from '../runstate/store.js';
import { emptyRunState, RunStateWatcher } from '../runstate/watch.js';
import { runUi, UiInteractionPorts } from '../ui/index.js';
import { splashEnabled } from './args.js';
import { fail, loadWorkflowOrFail, repoRootFromCwd } from './context.js';

/**
 * Read-only viewer for a run driven by another process: same graph UI, fed by
 * the run's state file instead of by an engine here. Meant to be left open in
 * a second window (or on a second monitor) beside a `flow-code run`.
 */
export async function cmdWatch(args: string[]): Promise<void> {
  const runId = args.find((a) => !a.startsWith('-'));
  const splash = splashEnabled(args, process.env);
  const repoRoot = await repoRootFromCwd();
  const workflow = loadWorkflowOrFail(repoRoot);
  const nodeIds = workflow.nodes.map((n) => n.id);

  if (runId !== undefined && !existsSync(runFilePath(repoRoot, runId))) {
    fail(`no run \`${runId}\` found in this repo — \`flow-code watch\` with no id follows the newest one.`);
  }

  // No persister is ever attached: this store is a sink for what the watcher
  // reads, never a source of writes. It starts on the placeholder state so
  // the graph is drawn — every node idle — even when no run exists yet.
  const store = new RunStateStore({ repoRoot, nodeIds });
  store.applySnapshot(emptyRunState(repoRoot, nodeIds));

  const watcher = new RunStateWatcher({
    repoRoot,
    nodeIds,
    ...(runId !== undefined ? { runId } : {}),
    onState: (state) => store.applySnapshot(state),
  });
  watcher.start();

  // Whatever `init` settled on, read straight off disk — a viewer must not
  // run the provider wizard or touch credentials the way `cmdRun` does.
  const saved = loadCredentials(repoRoot);

  await runUi({
    workflow,
    store,
    ports: new UiInteractionPorts(),
    watch: true,
    // Nothing to interrupt — ctrl+c just closes the viewer, and the run it
    // was watching carries on in its own window.
    onInterrupt: () => {},
    splash,
    modelContext: {
      providerId: saved?.provider,
      providerDefaultModel: saved?.model,
      workflowSettingsModel: workflow.settings.model,
    },
  });
  watcher.close();
  process.exit(0);
}
