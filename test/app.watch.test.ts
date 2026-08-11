import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, WATCH_READ_ONLY_MESSAGE, type ModelContext } from '../src/ui/App.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import { RunStateStore } from '../src/runstate/store.js';
import { emptyRunState } from '../src/runstate/watch.js';
import { makeTempGitRepo, markDriverDead, workflowFromYaml } from './helpers.js';

/**
 * Render tests for spectator mode. What matters here is what the header
 * claims about the run — a viewer that shows a stale graph as if it were live
 * is worse than no viewer — and that the workflow-mutating keys stay inert.
 */

const NO_MODEL_CONTEXT: ModelContext = {
  providerId: undefined,
  providerDefaultModel: undefined,
  workflowSettingsModel: undefined,
};

const WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);

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

function mountWatcher(store: RunStateStore): {
  stdout: FakeStdout;
  stdin: NodeJS.ReadStream;
  unmount: () => void;
} {
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(App, {
      workflow: WF,
      store,
      ports: new UiInteractionPorts(),
      modelContext: NO_MODEL_CONTEXT,
      watch: true,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { stdout, stdin, unmount: () => instance.unmount() };
}

describe('App watch mode', () => {
  it('draws the graph and says it is waiting when no run exists yet', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    store.applySnapshot(emptyRunState(repo, ['impl']));
    const { stdout, unmount } = mountWatcher(store);
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain('waiting for a run');
    // The point of the placeholder state: the node is on screen before any
    // run starts, rather than an empty canvas.
    expect(frame).toContain('impl');
    unmount();
  });

  it('names the run it is attached to once a snapshot arrives', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    store.applySnapshot(emptyRunState(repo, ['impl']));
    const { stdout, unmount } = mountWatcher(store);
    await settle();

    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    driver.setStatus('impl', 'running');
    store.applySnapshot(driver.snapshot());
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain(`watching ${driver.runId.slice(0, 8)}`);
    expect(frame).not.toContain('waiting for a run');
    unmount();
  });

  it('flags a run whose driver died, so a frozen graph is not read as a slow one', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    driver.setStatus('impl', 'running');
    // Max pid on Linux is well under this: nothing owns this run any more.
    store.applySnapshot(markDriverDead({ ...driver.snapshot() }));
    const { stdout, unmount } = mountWatcher(store);
    await settle();

    expect(lastFrame(stdout)).toContain('driver gone');
    unmount();
  });

  it('does not flag a finished run as having lost its driver', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    driver.setStatus('impl', 'done');
    driver.markFinished();
    store.applySnapshot({ ...driver.snapshot(), pid: 0x7ffffffe });
    const { stdout, unmount } = mountWatcher(store);
    await settle();

    const frame = lastFrame(stdout);
    expect(frame).toContain('finished');
    expect(frame).not.toContain('driver gone');
    unmount();
  });

  it('refuses the workflow-editing keys instead of opening their pickers', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['impl'] });
    store.applySnapshot(emptyRunState(repo, ['impl']));
    const { stdout, stdin, unmount } = mountWatcher(store);
    await settle();

    for (const key of ['m', 's', 'e']) {
      stdin.push(key);
      await settle();
      const frame = lastFrame(stdout);
      expect(frame).toContain(WATCH_READ_ONLY_MESSAGE);
      // The editor panel's own footer would be on screen if `e` had opened it.
      expect(frame).not.toContain('enter: edit');
    }
    unmount();
  });
});
