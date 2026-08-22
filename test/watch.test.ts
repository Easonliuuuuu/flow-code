import { mkdirSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunStatePersister, runFilePath, runsDir } from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { RunState } from '../src/runstate/types.js';
import {
  driverLiveness,
  emptyRunState,
  isAttached,
  latestRunState,
  liveRuns,
  newestRunFile,
  RunStateWatcher,
} from '../src/runstate/watch.js';
import { ambiguousRunsMessage } from '../src/cli/watch.js';
import { deadOwner, foreignOwner, liveOwner, makeTempGitRepo, markDriverDead } from './helpers.js';

function stateFixture(patch: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/repo',
    pid: 1234,
    owner: liveOwner(),
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

describe('driverLiveness', () => {
  it('reports this process as live', () => {
    expect(driverLiveness(stateFixture({ owner: liveOwner() }))).toBe('live');
  });

  it('reports an owner pid that no longer exists as dead', () => {
    expect(driverLiveness(stateFixture({ owner: deadOwner() }))).toBe('dead');
  });

  it('reports an owner on another machine as unknown, since its pid means nothing here', () => {
    expect(driverLiveness(stateFixture({ owner: foreignOwner() }))).toBe('unknown');
  });

  it('reports a document written before ownership as unknown rather than inferring from its pid', () => {
    const legacy = stateFixture();
    delete (legacy as { owner?: unknown }).owner;
    expect(driverLiveness(legacy)).toBe('unknown');
  });

  it('reports the placeholder state as unknown — it is attached to nothing to be alive', () => {
    expect(driverLiveness(emptyRunState('/repo', []))).toBe('unknown');
  });
});

describe('liveRuns', () => {
  it('is empty in a repo with no runs', () => {
    expect(liveRuns(makeTempGitRepo())).toEqual([]);
  });

  it('counts only runs that are unfinished and driven by a live process', () => {
    const repo = makeTempGitRepo();

    const live = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    live.attachPersister(new FileRunStatePersister(repo));

    const finished = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    finished.attachPersister(new FileRunStatePersister(repo));
    finished.markFinished(false);

    const crashed = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    crashed.attachPersister(new FileRunStatePersister(repo));
    new FileRunStatePersister(repo).persist(markDriverDead(crashed.snapshot()));

    expect(liveRuns(repo).map((s) => s.runId)).toEqual([live.runId]);
  });

  it('sees several live runs at once, so a reader can refuse to pick between them', () => {
    const repo = makeTempGitRepo();
    const one = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    one.attachPersister(new FileRunStatePersister(repo));
    const two = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    two.attachPersister(new FileRunStatePersister(repo));

    expect(liveRuns(repo).map((s) => s.runId).sort()).toEqual([one.runId, two.runId].sort());
  });

  it('reads no more than the cap, whatever the repo has accumulated', () => {
    const repo = makeTempGitRepo();
    for (let i = 0; i < 5; i++) {
      const store = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
      store.attachPersister(new FileRunStatePersister(repo));
    }
    expect(liveRuns(repo, 2)).toHaveLength(2);
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

  it('skips a stray file that is not a run, however recently it was written', () => {
    const repo = makeTempGitRepo();
    mkdirSync(runsDir(repo), { recursive: true });
    writeFileSync(runFilePath(repo, 'run-1'), JSON.stringify(stateFixture()));
    // Valid JSON, wrong shape: `runs/` holds whatever anyone drops in it, and
    // a reconcile report used to be exactly this.
    writeFileSync(join(runsDir(repo), 'notes.json'), '{"hello":"world"}');
    // Strictly newer, so picking by mtime alone lands on it. Set rather than
    // left to write order for the same reason as above — two back-to-back
    // writes share a millisecond, and the tie then turns on readdir order,
    // which is how this passed on one machine and failed on another.
    const now = Date.now() / 1000;
    utimesSync(runFilePath(repo, 'run-1'), now - 60, now - 60);
    utimesSync(join(runsDir(repo), 'notes.json'), now, now);

    expect(newestRunFile(repo)).toBe(runFilePath(repo, 'run-1'));
    expect(latestRunState(repo)!.runId).toBe('run-1');
  });

  it('is undefined when the directory holds nothing but strays', () => {
    const repo = makeTempGitRepo();
    mkdirSync(runsDir(repo), { recursive: true });
    writeFileSync(join(runsDir(repo), 'notes.json'), '{"hello":"world"}');
    writeFileSync(join(runsDir(repo), 'broken.json'), 'not json at all');

    expect(newestRunFile(repo)).toBeUndefined();
    expect(latestRunState(repo)).toBeUndefined();
  });
});

describe('RunStateWatcher', () => {
  it('emits the state a driver persists, unmodified — no reconciliation against any node list', async () => {
    const repo = makeTempGitRepo();
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    driver.attachPersister(new FileRunStatePersister(repo));

    const seen: RunState[] = [];
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      onState: (s) => seen.push(s),
      pollIntervalMs: 20,
    });
    watcher.start();
    try {
      driver.setStatus('discuss', 'running');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'running');

      // The driver never knew about `implement`; the watcher has no node
      // list of its own to reconcile against, so it just isn't there.
      expect(seen.at(-1)!.nodes['implement']).toBeUndefined();

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

  it('is unaffected by workflow.yaml being edited mid-run — it never reads it', async () => {
    const repo = makeTempGitRepo();
    const workflowPath = join(repo, 'workflow.yaml');
    writeFileSync(workflowPath, 'nodes:\n  - id: discuss\n    type: discuss\n');
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    driver.attachPersister(new FileRunStatePersister(repo));

    const seen: RunState[] = [];
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      onState: (s) => seen.push(s),
      pollIntervalMs: 20,
    });
    watcher.start();
    try {
      driver.setStatus('discuss', 'running');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'running');

      // Adds a node the run never knew about — a reconciling watcher would
      // pick this up; this one has no node list to reconcile against at all.
      writeFileSync(
        workflowPath,
        'nodes:\n  - id: discuss\n    type: discuss\n  - id: extra\n    type: implement\n    config: {}\n',
      );

      driver.setStatus('discuss', 'done');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'done');
      expect(seen.at(-1)!.nodes['extra']).toBeUndefined();
    } finally {
      watcher.close();
    }
  });

  it('keeps rendering a run after workflow.yaml has been deleted outright', async () => {
    const repo = makeTempGitRepo();
    const workflowPath = join(repo, 'workflow.yaml');
    writeFileSync(workflowPath, 'nodes:\n  - id: discuss\n    type: discuss\n');
    const driver = new RunStateStore({ repoRoot: repo, nodeIds: ['discuss'] });
    driver.attachPersister(new FileRunStatePersister(repo));

    const seen: RunState[] = [];
    const watcher = new RunStateWatcher({
      repoRoot: repo,
      onState: (s) => seen.push(s),
      pollIntervalMs: 20,
    });
    watcher.start();
    try {
      driver.setStatus('discuss', 'running');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'running');

      unlinkSync(workflowPath);

      driver.setStatus('discuss', 'done');
      await until(() => seen.at(-1)?.nodes['discuss']?.status === 'done');
      expect(seen.at(-1)!.nodes['discuss']!.status).toBe('done');
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

describe('ambiguousRunsMessage', () => {
  it('says nothing when there is one live run to attach to', () => {
    expect(ambiguousRunsMessage([])).toBeUndefined();
    expect(ambiguousRunsMessage([stateFixture({ runId: 'only-one' })])).toBeUndefined();
  });

  it('names every candidate when several are live, rather than picking one', () => {
    const message = ambiguousRunsMessage([
      stateFixture({ runId: 'aaaaaaaa-1111', createdAt: '2026-08-11T09:00:00.000Z' }),
      stateFixture({ runId: 'bbbbbbbb-2222', createdAt: '2026-08-11T10:30:00.000Z' }),
    ]);

    expect(message).toContain('2 runs are live');
    expect(message).toContain('aaaaaaaa');
    expect(message).toContain('bbbbbbbb');
    expect(message).toContain('flow-code watch <runId>');
  });
});
