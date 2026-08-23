import { render } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { RunStateStore } from '../runstate/store.js';
import type { RecordedGraph, RunState } from '../runstate/types.js';
import { isAttached } from '../runstate/watch.js';
import type { Workflow } from '../workflow/load.js';
import { RecordedGraphError, recordGraph, rehydrateGraph } from '../workflow/record.js';
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
  /** See `AppProps.demo`. */
  demo?: boolean;
}

/**
 * The part of a `RecordedGraph` worth re-rendering for: which nodes exist,
 * their types, and how they're wired. A node's own `config` (model, skills,
 * instructions, …) is deliberately excluded — `App` already reads current
 * per-node values from the store directly, never from `workflow`, so an
 * ordinary mid-run edit (`m`/`s`/`e`) replacing `state.graph` by reference
 * must not be mistaken for a shape change and pay for a `rehydrateGraph` it
 * gets no benefit from.
 */
function graphShapeKey(graph: RecordedGraph): string {
  return JSON.stringify({
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type })),
    edges: graph.edges,
  });
}

/**
 * Bridges the store's recorded graph into `App`'s `workflow` prop, so `App`
 * itself never has to know where a graph came from.
 *
 * Re-derives `workflow` from whichever `RecordedGraph` the store's current —
 * or next — snapshot carries, whenever its *shape* changes: unchanged on
 * every status/token update or field edit a run produces, and changing only
 * when the graph itself grows or replaces (a Plan node's proposal spliced
 * in; `watch` first attaching, or later attaching to a *different* run with
 * a different recorded shape). Independent of `watch` — a Plan node can
 * expand a graph `flow-code run` is driving directly, not only one `flow-code
 * watch` is spectating, and both need the redraw. `watch` still separately
 * governs read-only mode (see `AppProps.watch`), which is a different
 * concern this effect does not touch.
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
  demo,
}: WorkflowHostProps): React.ReactElement {
  const [workflow, setWorkflow] = useState<Workflow>(initialWorkflow);
  const [graphIssue, setGraphIssue] = useState<string | null>(null);
  const lastGraphRef = useRef<RecordedGraph | undefined>(undefined);
  const lastShapeKeyRef = useRef<string | undefined>(
    watch ? undefined : graphShapeKey(recordGraph(initialWorkflow)),
  );

  useEffect(() => {
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
        // Only reachable under `watch`: a run driven directly always records
        // a graph before this component ever mounts.
        setGraphIssue(isAttached(state) ? 'shape unavailable — this run predates recorded graphs' : null);
        return;
      }
      const shapeKey = graphShapeKey(state.graph);
      if (shapeKey === lastShapeKeyRef.current) return;
      lastShapeKeyRef.current = shapeKey;
      try {
        setWorkflow(rehydrateGraph(state.graph, { repoRoot }));
        setGraphIssue(null);
      } catch (err) {
        if (err instanceof RecordedGraphError) setGraphIssue(err.message);
        else throw err;
      }
    };
    // Catch up on whatever the store already holds — under `watch`,
    // `RunStateWatcher.start` runs its first check synchronously, which can
    // land before this effect subscribes; driving a run directly, the store
    // may already have moved (a Plan node can expand the graph before this
    // component's first render commits) — either way, there is no gap to
    // miss a change in.
    apply(store.snapshot());
    return store.subscribe(apply);
  }, [store, repoRoot]);

  return React.createElement(App, {
    workflow,
    store,
    ports,
    modelContext,
    watch,
    graphIssue,
    onExit,
    onInterrupt,
    ...(demo !== undefined ? { demo } : {}),
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
  /** See `AppProps.demo`. */
  demo?: boolean;
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
          ...(opts.demo !== undefined ? { demo: opts.demo } : {}),
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
        // A fresh Ink instance has no memory of what's on screen — its
        // diff-based redraw assumes zero previous output. On the primary
        // screen that assumption can drift from reality (terminal scroll,
        // leftover splash frame), which a full-canvas repaint like panning
        // then reveals as stray glyphs. The alternate screen sidesteps this:
        // entering it always starts from a guaranteed-blank buffer, so the
        // diff math and the terminal agree from frame one. Same reasoning as
        // the splash mount below.
        { exitOnCtrlC: false, alternateScreen: true },
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
