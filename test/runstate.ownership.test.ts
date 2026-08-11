import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  driverLiveness,
  FileRunStatePersister,
  readRunState,
  RunOwnershipError,
  runFilePath,
} from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import { makeTempGitRepo, markDriverDead } from './helpers.js';

/** A store already writing to `repo`, as a live driver would be. */
function driving(repo: string): RunStateStore {
  const store = new RunStateStore({ repoRoot: repo, nodeIds: ['a', 'b'] });
  store.attachPersister(new FileRunStatePersister(repo));
  return store;
}

describe('a run document records who owns it', () => {
  it('stamps this process, this machine, and a token only this writer holds', () => {
    const repo = makeTempGitRepo();
    const owner = driving(repo).snapshot().owner;

    expect(owner?.pid).toBe(process.pid);
    expect(owner?.token).toBeTruthy();
    expect(owner?.claimedAt).toBeTruthy();
  });

  it('gives two runs different tokens, so one cannot be mistaken for the other', () => {
    const repo = makeTempGitRepo();
    expect(driving(repo).snapshot().owner?.token).not.toBe(driving(repo).snapshot().owner?.token);
  });

  it('records no handover for a run that was never resumed', () => {
    expect(driving(makeTempGitRepo()).snapshot().handovers).toBeUndefined();
  });
});

describe('a writer that does not own a run is refused', () => {
  it('refuses a second writer and leaves the document byte-identical', () => {
    const repo = makeTempGitRepo();
    const owner = driving(repo);
    const path = runFilePath(repo, owner.runId);
    const before = readFileSync(path, 'utf8');

    // A different process would arrive with its own owner token, which is
    // exactly what a second store in this process produces.
    const intruder = new RunStateStore({ repoRoot: repo, runId: owner.runId, nodeIds: ['a', 'b'] });
    expect(() => new FileRunStatePersister(repo).persist(intruder.snapshot())).toThrow(RunOwnershipError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('names the run and the process that holds it, so the failure is actionable', () => {
    const repo = makeTempGitRepo();
    const owner = driving(repo);
    const intruder = new RunStateStore({ repoRoot: repo, runId: owner.runId, nodeIds: ['a'] });

    expect(() => new FileRunStatePersister(repo).persist(intruder.snapshot())).toThrow(
      new RegExp(`${owner.runId}.*already being driven by pid ${process.pid}`),
    );
  });

  it('refuses a writer that owned the run and then lost it', () => {
    const repo = makeTempGitRepo();
    const store = driving(repo);
    const persister = new FileRunStatePersister(repo);
    persister.persist(store.snapshot());

    // Something else takes the run over between our writes.
    const successor = new RunStateStore({ repoRoot: repo, runId: store.runId, nodeIds: ['a'] });
    writeFileSync(runFilePath(repo, store.runId), JSON.stringify(successor.snapshot(), null, 2));

    expect(() => persister.persist(store.snapshot())).toThrow(/taken over by another process/);
  });

  it('reports the refusal rather than continuing as though state were still recorded', () => {
    const repo = makeTempGitRepo();
    const owner = driving(repo);
    const intruder = new RunStateStore({ repoRoot: repo, runId: owner.runId, nodeIds: ['a'] });
    const persister = new FileRunStatePersister(repo);

    // The refusal is thrown, not swallowed — a run whose state has silently
    // stopped being written is worse than one that fails, because the graph
    // keeps looking right.
    expect(() => persister.persist(intruder.snapshot())).toThrow(RunOwnershipError);
  });

  it('adopts a run whose document is unreadable, since there is no owner to respect', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    const persister = new FileRunStatePersister(repo);
    writeFileSync(runFilePath(repo, store.runId), '{ this is not a run');

    expect(() => persister.persist(store.snapshot())).not.toThrow();
    expect(readRunState(runFilePath(repo, store.runId)).runId).toBe(store.runId);
  });
});

describe('ownership transfers on resume', () => {
  it('takes over a run whose driver is gone, and accepts its writes afterwards', () => {
    const repo = makeTempGitRepo();
    const original = driving(repo);
    original.setStatus('a', 'done');
    original.markFinished(true);
    const abandoned = markDriverDead(structuredClone(original.snapshot()));

    const resumed = new RunStateStore({ repoRoot: repo, nodeIds: ['a', 'b'], resumeFrom: abandoned });
    resumed.attachPersister(new FileRunStatePersister(repo));
    resumed.setStatus('b', 'running');

    expect(resumed.runId).toBe(original.runId);
    expect(readRunState(runFilePath(repo, original.runId)).nodes['b']!.status).toBe('running');
  });

  it('records the handover, so a resumed run is distinguishable from one driven throughout', () => {
    const repo = makeTempGitRepo();
    const original = driving(repo);
    original.markFinished(true);
    const prior = original.snapshot();

    const resumed = new RunStateStore({ repoRoot: repo, nodeIds: ['a', 'b'], resumeFrom: prior });

    expect(resumed.snapshot().handovers).toEqual([{ from: { pid: prior.owner!.pid, host: prior.owner!.host }, at: expect.any(String) }]);
    expect(resumed.snapshot().owner?.token).not.toBe(prior.owner?.token);
  });

  it('refuses to resume a run that is still being driven, and leaves it untouched', () => {
    const repo = makeTempGitRepo();
    const live = driving(repo);
    live.setStatus('a', 'running');
    const path = runFilePath(repo, live.runId);
    const before = readFileSync(path, 'utf8');

    expect(
      () => new RunStateStore({ repoRoot: repo, nodeIds: ['a', 'b'], resumeFrom: live.snapshot() }),
    ).toThrow(/already being driven/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('resumes a run whose owner predates ownership, rather than refusing every older run', () => {
    const repo = makeTempGitRepo();
    const original = driving(repo);
    original.markFinished(true);
    const legacy = structuredClone(original.snapshot());
    delete (legacy as { owner?: unknown }).owner;

    expect(driverLiveness(legacy)).toBe('unknown');
    expect(() => new RunStateStore({ repoRoot: repo, nodeIds: ['a'], resumeFrom: legacy })).not.toThrow();
  });
});

describe('a crash mid-write leaves the previous document intact', () => {
  it('publishes by rename, so a leftover partial write is never the published document', () => {
    const repo = makeTempGitRepo();
    const store = driving(repo);
    store.setStatus('a', 'running');
    const path = runFilePath(repo, store.runId);

    // What a process killed partway through a write leaves behind: a partial
    // temporary file beside a complete published one.
    writeFileSync(`${path}.tmp`, '{"runId":"half-writ');

    const recovered = readRunState(path);
    expect(recovered.runId).toBe(store.runId);
    expect(recovered.nodes['a']!.status).toBe('running');
  });

  it('leaves the last completed write in place when the next one is refused', () => {
    const repo = makeTempGitRepo();
    const store = driving(repo);
    store.setStatus('a', 'running');
    const path = runFilePath(repo, store.runId);
    const before = readFileSync(path, 'utf8');

    const intruder = new RunStateStore({ repoRoot: repo, runId: store.runId, nodeIds: ['a'] });
    expect(() => new FileRunStatePersister(repo).persist(intruder.snapshot())).toThrow();

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readRunState(path).nodes['a']!.status).toBe('running');
  });
});
