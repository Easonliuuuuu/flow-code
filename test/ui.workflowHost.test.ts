import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/runstate/store.js';
import { emptyRunState } from '../src/runstate/watch.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import { WorkflowHost } from '../src/ui/index.js';
import type { ModelContext } from '../src/ui/App.js';
import { emptyWorkflow, loadWorkflowFromString } from '../src/workflow/load.js';
import { recordGraph } from '../src/workflow/record.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openGuestRun, reportTransition } from '../src/guest/report.js';
import { latestRunState } from '../src/runstate/watch.js';
import { makeTempGitRepo } from './helpers.js';

/**
 * Render tests for the swappable-workflow mechanism: `WorkflowHost` derives
 * `App`'s `workflow` prop from whatever `RecordedGraph` the store's current —
 * or next — snapshot carries, rather than a static prop fixed at mount. See
 * `src/ui/index.ts`.
 */

const NO_MODEL_CONTEXT: ModelContext = {
  providerId: undefined,
  providerDefaultModel: undefined,
  workflowSettingsModel: undefined,
};

const ROWS = 30;
const COLUMNS = 100;

interface FakeStdout extends NodeJS.WriteStream {
  frames: string[];
}

function fakeStdout(): FakeStdout {
  const frames: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as unknown as FakeStdout;
  Object.assign(out, { columns: COLUMNS, rows: ROWS, isTTY: true, frames });
  return out;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stream, { isTTY: true, setRawMode: () => stream, ref: () => {}, unref: () => {} });
  return stream;
}

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastFrame(stdout: FakeStdout): string {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return plain.filter((f) => f.trim().length > 0).at(-1) ?? '';
}

function mountHost(
  repoRoot: string,
  store: RunStateStore,
  opts: { watch?: boolean; initialWorkflow?: ReturnType<typeof emptyWorkflow> } = {},
): { stdout: FakeStdout; unmount: () => void } {
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(WorkflowHost, {
      initialWorkflow: opts.initialWorkflow ?? emptyWorkflow(repoRoot),
      store,
      ports: new UiInteractionPorts(),
      modelContext: NO_MODEL_CONTEXT,
      watch: opts.watch ?? true,
      repoRoot,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { stdout, unmount: () => instance.unmount() };
}

const GRAPH_A = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`;

const PLANNED = `
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: ship }
`;

const GRAPH_B = `
nodes:
  - id: review
    type: review
`;

describe('WorkflowHost', () => {
  it('shows an honest placeholder before any run has attached', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: [] });
    store.applySnapshot(emptyRunState(repo, []));
    const { stdout, unmount } = mountHost(repo, store);
    await settle();

    expect(lastFrame(stdout)).toContain('waiting for a run');
    unmount();
  });

  it('swaps in the recorded graph once a run attaches', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: [] });
    store.applySnapshot(emptyRunState(repo, []));
    const { stdout, unmount } = mountHost(repo, store);
    await settle();
    expect(lastFrame(stdout)).not.toContain('impl');

    const driver = new RunStateStore({
      repoRoot: repo,
      graph: recordGraph(loadWorkflowFromString(GRAPH_A, { repoRoot: repo })),
    });
    store.applySnapshot(driver.snapshot());
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain('impl');
    expect(frame).not.toContain('waiting for a run');
    unmount();
  });

  it('swaps again when the viewer attaches to a second run with a different recorded shape', async () => {
    const repo = makeTempGitRepo();
    const first = new RunStateStore({
      repoRoot: repo,
      graph: recordGraph(loadWorkflowFromString(GRAPH_A, { repoRoot: repo })),
    });
    const store = new RunStateStore({ repoRoot: repo, nodeIds: [] });
    store.applySnapshot(first.snapshot());
    const { stdout, unmount } = mountHost(repo, store);
    await settle();
    expect(lastFrame(stdout)).toContain('impl');

    const second = new RunStateStore({
      repoRoot: repo,
      graph: recordGraph(loadWorkflowFromString(GRAPH_B, { repoRoot: repo })),
    });
    store.applySnapshot(second.snapshot());
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain('review');
    expect(frame).not.toContain('impl');
    unmount();
  });

  it('reports shape-unavailable, without falling back to workflow.yaml, for a run predating recorded graphs', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: [] });
    store.applySnapshot(emptyRunState(repo, []));
    const { stdout, unmount } = mountHost(repo, store);
    await settle();

    // A legacy run document: attached (non-empty runId), but no `graph`.
    const legacy = new RunStateStore({ repoRoot: repo, nodeIds: ['whatever'] });
    store.applySnapshot(legacy.snapshot());
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain('shape unavailable');
    expect(frame).not.toContain('whatever');
    unmount();
  });

  it('surfaces a RecordedGraphError instead of crashing or blanking the canvas', async () => {
    const repo = makeTempGitRepo();
    const recorded = recordGraph(loadWorkflowFromString(GRAPH_A, { repoRoot: repo }));
    const driver = new RunStateStore({ repoRoot: repo, graph: recorded });
    const store = new RunStateStore({ repoRoot: repo, nodeIds: [] });
    store.applySnapshot(driver.snapshot());
    const { stdout, unmount } = mountHost(repo, store);
    await settle();
    expect(lastFrame(stdout)).toContain('impl');

    // A node type this build no longer has — what a run interrupted under
    // one version and resumed/watched under another looks like.
    const broken = new RunStateStore({
      repoRoot: repo,
      graph: { ...recorded, nodes: [{ id: 'impl', type: 'retired-node-type', config: {} }] },
    });
    store.applySnapshot(broken.snapshot());
    await settle();

    const frame = lastFrame(stdout);
    // Still showing the last good graph, not a blank canvas or a crash.
    expect(frame).toContain('impl');
    expect(frame).toContain('cannot rebuild the graph');
    unmount();
  });
});

describe('WorkflowHost redraws reactively even when not watching', () => {
  // `flow-code run` mounts with `watch: false` — this is what a Plan node
  // expanding the graph mid-run relies on, see cli/run.ts and
  // engine/engine.ts's `awaiting-expansion` outcome.
  it('picks up a Plan node expanding the graph, on the same store instance, without `watch`', async () => {
    const repo = makeTempGitRepo();
    const initial = loadWorkflowFromString(GRAPH_A, { repoRoot: repo });
    const store = new RunStateStore({ repoRoot: repo, graph: recordGraph(initial) });
    const { stdout, unmount } = mountHost(repo, store, { watch: false, initialWorkflow: initial });
    await settle();
    expect(lastFrame(stdout)).toContain('impl');
    expect(lastFrame(stdout)).not.toContain('review');

    const expanded = loadWorkflowFromString(
      `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: review
    type: review
edges:
  - { from: impl, to: review }
`,
      { repoRoot: repo },
    );
    store.expandGraph(recordGraph(expanded));
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain('impl');
    expect(frame).toContain('review');
    unmount();
  });

  // A guest-driven expansion reaches a viewer by a different route: the run
  // document changes on disk and `flow-code watch` feeds it in whole through
  // `applySnapshot` (see cli/watch.ts), rather than the engine calling
  // `expandGraph` on a store it shares with the UI.
  it('picks up an expansion that arrives as a whole snapshot, the way `watch` delivers one', async () => {
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), PLANNED);

    const { runId } = await openGuestRun(repo, { surface: 'cli' });
    reportTransition(repo, runId, { nodeId: 'plan', kind: 'start' });

    const store = new RunStateStore({ repoRoot: repo, nodeIds: [] });
    store.applySnapshot(latestRunState(repo)!);
    const { stdout, unmount } = mountHost(repo, store, { watch: false });
    await settle();
    expect(lastFrame(stdout)).toContain('plan');
    expect(lastFrame(stdout)).not.toContain('impl');

    reportTransition(repo, runId, {
      nodeId: 'plan',
      kind: 'done',
      output: {
        nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'build it' } }],
        edges: [],
      },
    });
    store.applySnapshot(latestRunState(repo)!);
    await settle();

    // No reattach, no reload of workflow.yaml — which still declares three
    // nodes and knows nothing about `impl`.
    const frame = lastFrame(stdout);
    expect(frame).toContain('plan');
    expect(frame).toContain('impl');
    unmount();
  });

  it('does not re-render on an ordinary field edit that leaves the graph shape unchanged', async () => {
    const repo = makeTempGitRepo();
    const initial = loadWorkflowFromString(GRAPH_A, { repoRoot: repo });
    const store = new RunStateStore({ repoRoot: repo, graph: recordGraph(initial) });
    const { stdout, unmount } = mountHost(repo, store, { watch: false, initialWorkflow: initial });
    await settle();
    const before = lastFrame(stdout);

    // Same node, same edges — only its config changes, as `m`/`s`/`e` do.
    store.patchGraphNode('impl', { config: { instructions: 'a different instruction' } });
    await settle();

    // No crash, no graph re-derivation — the frame is stable across an edit
    // that doesn't touch which nodes exist or how they're wired.
    expect(lastFrame(stdout)).toBe(before);
    unmount();
  });
});
