import { render } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { RunStateStore } from '../runstate/store.js';
import type { RecordedGraph, RunState } from '../runstate/types.js';
import { isAttached } from '../runstate/watch.js';
import type { Workflow } from '../workflow/load.js';
import { RecordedGraphError, rehydrateGraph } from '../workflow/record.js';
import { App, type ModelContext } from './App.js';
import type { UiInteractionPorts } from './ports.js';
import { Splash } from './splash.js';

export { UiInteractionPorts } from './ports.js';
export type { ModelContext } from './App.js';

interface WorkflowHostProps {
  initialWorkflow: Workflow;
  store: RunStateStore;
  ports: UiInteractionPorts;
  onExit: () => void;
  onInterrupt: () => void;
  modelContext: ModelContext;
  watch: boolean;
  repoRoot: string;
}

/**
 * Bridges the store's recorded graph into `App`'s `workflow` prop, so `App`
 * itself never has to know where a graph came from.
 *
 * `run` mounts this with `watch` false: the effect below returns immediately,
 * so `workflow` never changes from `initialWorkflow` and the path is exactly
 * as it was before this existed — no new I/O, no new failure mode.
 *
 * `watch` mounts with `emptyWorkflow`'s placeholder and no run attached yet.
 * The effect re-derives `workflow` from whichever `RecordedGraph` the store's
 * current — or next — snapshot carries, by reference: unchanged on every
 * status/token update a run produces, and changing only when the graph itself
 * does (first attach, or a long-lived viewer later attaching to a *different*
 * run with a different recorded shape).
 */
export function WorkflowHost({
  initialWorkflow,
  store,
  ports,
  onExit,
  onInterrupt,
  modelContext,
  watch,
  repoRoot,
}: WorkflowHostProps): React.ReactElement {
  const [workflow, setWorkflow] = useState<Workflow>(initialWorkflow);
  const [graphIssue, setGraphIssue] = useState<string | null>(null);
  const lastGraphRef = useRef<RecordedGraph | undefined>(undefined);

  useEffect(() => {
    if (!watch) return;
    const apply = (state: RunState): void => {
      // The reference-equality skip only applies once there is a graph to
      // compare by reference. `undefined === undefined` would otherwise make
      // every graphless state look unchanged — including the transition from
      // "nothing attached yet" to "attached, but this run predates recorded
      // graphs", which is exactly the distinction `graphIssue` exists to draw.
      if (state.graph !== undefined && state.graph === lastGraphRef.current) return;
      lastGraphRef.current = state.graph;
      if (state.graph === undefined) {
        // No fallback to `workflow.yaml`: keep showing whatever shape is
        // already up, and only say something when there is a run to blame it
        // on — the pre-attach placeholder isn't "unavailable", it's honest.
        setGraphIssue(isAttached(state) ? 'shape unavailable — this run predates recorded graphs' : null);
        return;
      }
      try {
        setWorkflow(rehydrateGraph(state.graph, { repoRoot }));
        setGraphIssue(null);
      } catch (err) {
        if (err instanceof RecordedGraphError) setGraphIssue(err.message);
        else throw err;
      }
    };
    // Catch up on whatever the store already holds — `RunStateWatcher.start`
    // runs its first check synchronously, which can land before this effect
    // subscribes — then follow every snapshot after.
    apply(store.snapshot());
    return store.subscribe(apply);
  }, [watch, store, repoRoot]);

  return React.createElement(App, {
    workflow,
    store,
    ports,
    modelContext,
    watch,
    graphIssue,
    onExit,
    onInterrupt,
  });
}

/** Mount the terminal UI; resolves when the user exits. */
export function runUi(opts: {
  workflow: Workflow;
  store: RunStateStore;
  ports: UiInteractionPorts;
  onInterrupt: () => void;
  modelContext: ModelContext;
  repoRoot: string;
  /** Read-only spectator mode — see `AppProps.watch`. */
  watch?: boolean;
  /** Skip the startup splash entirely, even in a TTY (`--no-splash`). Defaults to playing it. */
  splash?: boolean;
}): Promise<void> {
  return new Promise((resolve) => {
    // Ink's raw-mode-enabled stdin is what normally keeps the process alive
    // while a UI is mounted, but the splash→App handoff — two sequential
    // Ink instances on the same stdin — has a window where nothing holds
    // the event loop open: the splash unrefs stdin on unmount, and the new
    // instance's own raw-mode ref lands via React's scheduler rather than
    // synchronously. When there's nothing else keeping Node alive (e.g. a
    // fresh repo with no `.flow-code/runs/` yet, where the watcher's
    // fs.watch never attaches and its poll timer is deliberately unref'd —
    // see RunStateWatcher.start), the process can exit mid-session with no
    // error and no unmount. A trivial ref'd timer for the lifetime of this
    // promise closes that gap without depending on Ink internals.
    const keepAlive = setInterval(() => {}, 1 << 30);
    const finish = (): void => {
      clearInterval(keepAlive);
      resolve();
    };
    const mountApp = (): void => {
      const instance = render(
        React.createElement(WorkflowHost, {
          initialWorkflow: opts.workflow,
          store: opts.store,
          ports: opts.ports,
          modelContext: opts.modelContext,
          watch: opts.watch ?? false,
          repoRoot: opts.repoRoot,
          onExit: () => {
            instance.unmount();
            finish();
          },
          // App owns ctrl+c (exitOnCtrlC below is off) so we can interrupt the
          // engine, not just unmount the UI over a still-running session.
          onInterrupt: () => {
            instance.unmount();
            opts.onInterrupt();
            finish();
          },
        }),
        { exitOnCtrlC: false },
      );
      void instance.waitUntilExit().then(() => finish());
    };

    // The intro plays on its own alternate screen (restored to whatever was
    // on screen before it, cleanly, the moment it unmounts) so it never
    // leaves stray frames in scrollback above the graph. Ink requires the
    // previous instance unmounted before a fresh `render()` reuses the same
    // stdout, hence mounting App only from the splash's own completion. With
    // the splash opted out there's no handoff to sequence, so App mounts
    // immediately.
    if (opts.splash === false) {
      mountApp();
      return;
    }
    const splash = render(
      React.createElement(Splash, {
        onDone: () => {
          splash.unmount();
          // Deliberately a macrotask, not a synchronous call. Ink defers the
          // *terminal* half of its raw-mode teardown to a queueMicrotask,
          // guarded by a ref that is private to each Ink instance
          // (`pendingDisableRawModeRef`, ink/components/App.js). Two instances
          // over one process.stdin therefore can't see each other's pending
          // teardown: mounting App synchronously here let its
          // `stdin.setRawMode(true)` land first and the splash's queued
          // `setRawMode(false)` + `stdin.unref()` land second, leaving the
          // graph mounted over a cooked-mode tty — every keystroke echoed by
          // the terminal, the mouse-tracking sequences App just enabled
          // echoed as garbage alongside them, no key reaching Ink at all, and
          // only a real SIGINT able to quit. (The same stray unref is what
          // `keepAlive` above compensates for.) A timeout runs after the
          // microtask queue drains, so the teardown always completes before
          // App claims stdin.
          setTimeout(mountApp, 0);
        },
      }),
      { exitOnCtrlC: false, alternateScreen: true },
    );
  });
}
