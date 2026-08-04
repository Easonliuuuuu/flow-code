import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunStatePersister, runFilePath, runsDir } from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { RunState } from '../src/runstate/types.js';
import {
  emptyRunState,
  isAttached,
  isDriverAlive,
  latestRunState,
  newestRunFile,
  reconcileRunState,
  RunStateWatcher,
} from '../src/runstate/watch.js';
import { makeTempGitRepo } from './helpers.js';

function stateFixture(patch: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/repo',
    pid: 1234,
    baseline: null,
    nodes: {},
    worktrees: [],
    activity: [],
    ...patch,
  };
}

/** Waits for `predicate`, polling — the watcher is driven by real fs events/timers. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for the watcher');
}

describe('reconcileRunState', () => {
  it('renders nodes the run never knew about as idle, so a workflow edited mid-run still draws', () => {
    const state = stateFixture({
      nodes: { discuss: { status: 'done', denials: 0 } },
    });

    const reconciled = reconcileRunState(state, ['discuss', 'implement']);

    expect(reconciled.nodes['discuss']!.status).toBe('done');
    expect(reconciled.nodes['implement']).toEqual({ status: 'idle', denials: 0 });
  });

  it('drops nodes the workflow no longer has, since the canvas indexes by workflow node id', () => {
    const state = stateFixture({
      nodes: {
        discuss: { status: 'done', denials: 0 },
        removed: { status: 'error', denials: 3 },
      },
    });

    const reconciled = reconcileRunState(state, ['discuss']);

    expect(Object.keys(reconciled.nodes)).toEqual(['discuss']);
  });

  it('keeps the activity log whole, including entries for departed nodes', () => {
    const state = stateFixture({
      nodes: { discuss: { status: 'done', denials: 0 } },
      activity: [
        { ts: '2026-01-01T00:00:01.000Z', nodeId: 'removed', tool: 'Bash', summary: 'ls', decision: 'allowed' },
      ],
    });

    expect(reconcileRunState(state, ['discuss']).activity).toHaveLength(1);
  });
});

describe('emptyRunState', () => {
  it('is not attached, and gives every workflow node an idle card to draw', () => {
    const state = emptyRunState('/repo', ['a', 'b']);

    expect(isAttached(state)).toBe(false);
    expect(state.nodes['a']!.status).toBe('idle');
    expect(state.nodes['b']!.status).toBe('idle');
  });

  it('is distinguishable from a real run, which is attached', () => {
    expect(isAttached(stateFixture())).toBe(true);
  });
});

describe('isDriverAlive', () => {
  it('reports this process as alive', () => {
    expect(isDriverAlive(stateFixture({ pid: process.pid }))).toBe(true);
  });

  it('reports a pid that no longer exists as gone', () => {
    // Max pid on Linux is well under this; nothing can be running here.
    expect(isDriverAlive(stateFixture({ pid: 0x7ffffffe }))).toBe(false);
  });

  it('treats the placeholder state (pid 0) as having no driver', () => {
    expect(isDriverAlive(emptyRunState('/repo', []))).toBe(false);
  });
});

describe('newestRunFile', () => {
  it('is undefined before any run has been written', () => {
    expect(newestRunFile(makeTempGitRepo())).toBeUndefined();
    expect(latestRunState(makeTempGitRepo())).toBeUndefined();
  });

  it('follows the most recently written run, not the most recently created one', () => {
    const repo = makeTempGitRepo();
    mkdirSync(runsDir(repo), { recursive: true });
    // `old` was created first but is still being written to — which is what
    // `--resume` looks like, since it keeps the original runId and createdAt.
    const older = stateFixture({ runId: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = stateFixture({ runId: 'new', createdAt: '2026-06-01T00:00:00.000Z' });
    writeFileSync(runFilePath(repo, 'new'), JSON.stringify(newer));
    writeFileSync(runFilePath(repo, 'old'), JSON.stringify(older));
    // Set mtimes rather than leaning on write order: back-to-back writes land
    // in the same millisecond, which is the one thing this test must not
    // depend on.
    const now = Date.now() / 1000;
    utimesSync(runFilePath(repo, 'new'), now - 60, now - 60);
    utimesSync(runFilePath(repo, 'old'), now, now);

    expect(newestRunFile(repo)).toBe(join(runsDir(repo), 'old.json'));
    expect(latestRunState(repo)!.runId).toBe('old');
  });
});

describe('RunStateWatcher', () => {
  it('emits the state a driver persists, reconciled to the workflow', async () => {
    const repo = makeTempGitRepo();
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    driver.attachPersister(new FileRunStatePersister(repo));

    const seen: RunState[] = [];
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      nodeIds: ['discuss', 'implement'],
      onState: (s) => seen.push(s),
      pollIntervalMs: 20,
    });
    watcher.start();
    try {
      driver.setStatus('discuss', 'running');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'running');

      // The driver never knew about `implement`; the viewer still draws it.
      expect(seen.at(-1)!.nodes['implement']).toEqual({ status: 'idle', denials: 0 });

      driver.setStatus('discuss', 'done');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'done');
    } finally {
      watcher.close();
    }
  });

  it('picks up a run started after the viewer was already open', async () => {
    const repo = makeTempGitRepo();
    const seen: RunState[] = [];
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      nodeIds: ['discuss'],
      onState: (s) => seen.push(s),
      pollIntervalMs: 20,
    });
    // No runs dir yet — the fs.watch call has nothing to attach to, so this
    // is also the regression test for the poll fallback carrying it.
    watcher.start();
    try {
      expect(seen).toHaveLength(0);

      const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
      driver.attachPersister(new FileRunStatePersister(repo));
      driver.setStatus('discuss', 'running');

      await until(() => seen.at(-1)?.runId === driver.runId);
    } finally {
      watcher.close();
    }
  });

  it('stays on one run when pinned to a run id', async () => {
    const repo = makeTempGitRepo();
    const pinned = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    pinned.attachPersister(new FileRunStatePersister(repo));
    pinned.setStatus('discuss', 'running');

    const seen: RunState[] = [];
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      nodeIds: ['discuss'],
      runId: pinned.runId,
      onState: (s) => seen.push(s),
      pollIntervalMs: 20,
    });
    watcher.start();
    try {
      await until(() => seen.length > 0);

      // A second run starts and writes later — the pinned viewer ignores it.
      const other = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
      other.attachPersister(new FileRunStatePersister(repo));
      other.setStatus('discuss', 'error');

      pinned.setStatus('discuss', 'done');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'done');
      expect(seen.every((s) => s.runId === pinned.runId)).toBe(true);
    } finally {
      watcher.close();
    }
  });

  it('never writes to the run it is watching', async () => {
    const repo = makeTempGitRepo();
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    driver.attachPersister(new FileRunStatePersister(repo));
    driver.setStatus('discuss', 'running');

    const viewer = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      nodeIds: ['discuss'],
      onState: (s) => viewer.applySnapshot(s),
      pollIntervalMs: 20,
    });
    watcher.start();
    try {
      await until(() => viewer.snapshot().nodes['discuss']?.status === 'running');

      // The viewer adopted the run it read rather than keeping its own id —
      // and, crucially, never persisted a run file of its own alongside it.
      expect(viewer.snapshot().runId).toBe(driver.runId);
      expect(readdirSync(runsDir(repo))).toEqual([`${driver.runId}.json`]);
    } finally {
      watcher.close();
    }
  });
});
