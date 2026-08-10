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
): { stdout: FakeStdout; unmount: () => void } {
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(WorkflowHost, {
      initialWorkflow: emptyWorkflow(repoRoot),
      store,
      ports: new UiInteractionPorts(),
      modelContext: NO_MODEL_CONTEXT,
      watch: true,
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
