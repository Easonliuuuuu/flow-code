import { existsSync } from 'node:fs';
import { loadCredentials } from '../engine/credentials.js';
import { runFilePath } from '../runstate/persist.js';
import { RunStateStore } from '../runstate/store.js';
import { emptyRunState, RunStateWatcher } from '../runstate/watch.js';
import { runUi, UiInteractionPorts } from '../ui/index.js';
import { emptyWorkflow } from '../workflow/load.js';
import { splashEnabled } from './args.js';
import { fail, repoRootFromCwd } from './context.js';

/**
 * Read-only viewer for a run driven by another process: same graph UI, fed by
 * the run's state file instead of by an engine here. Meant to be left open in
 * a second window (or on a second monitor) beside a `flow-code run`.
 *
 * Never loads `.flow-code/workflow.yaml`: the graph on screen comes entirely
 * from the run document it attaches to (`WorkflowHost`, `src/ui/index.ts`,
 * rehydrates it from `RunState.graph`), so a viewer needs no node ids of its
 * own up front — just the placeholder shape to draw before anything attaches.
 */
export async function cmdWatch(args: string[]): Promise<void> {
  const runId = args.find((a) => !a.startsWith('-'));
  const splash = splashEnabled(args, process.env);
  const repoRoot = await repoRootFromCwd();

  if (runId !== undefined && !existsSync(runFilePath(repoRoot, runId))) {
    fail(`no run \`${runId}\` found in this repo — \`flow-code watch\` with no id follows the newest one.`);
  }

  // No persister is ever attached: this store is a sink for what the watcher
  // reads, never a source of writes. It starts on the placeholder state so
  // the graph is drawn — every node idle — even when no run exists yet.
  const store = new RunStateStore({ repoRoot, nodeIds: [] });
  store.applySnapshot(emptyRunState(repoRoot, []));

  const watcher = new RunStateWatcher({
    repoRoot,
    ...(runId !== undefined ? { runId } : {}),
    onState: (state) => store.applySnapshot(state),
  });
  watcher.start();

  // Whatever `init` settled on, read straight off disk — a viewer must not
  // run the provider wizard or touch credentials the way `cmdRun` does.
  const saved = loadCredentials(repoRoot);

  await runUi({
    workflow: emptyWorkflow(repoRoot),
    store,
    ports: new UiInteractionPorts(),
    watch: true,
    repoRoot,
    // Nothing to interrupt — ctrl+c just closes the viewer, and the run it
    // was watching carries on in its own window.
    onInterrupt: () => {},
    splash,
    modelContext: {
      providerId: saved?.provider,
      providerDefaultModel: saved?.model,
      // No workflow file is loaded up front to read this from anymore; left
      // unset means the header can't distinguish a node's own model override
      // from one inherited from `settings.model` until a real graph attaches
      // (minor, and only visible for the instant before that happens).
      workflowSettingsModel: undefined,
    },
  });
  watcher.close();
  process.exit(0);
}
