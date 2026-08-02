import { describe, expect, it } from 'vitest';
import {
  FileRunStatePersister,
  findInterruptedRun,
  findLatestInterruptedRun,
  readRunState,
  runFilePath,
} from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import { makeTempGitRepo } from './helpers.js';

describe('run-state persistence', () => {
  it('persists every activity entry as it occurs, so a crash cannot lose them', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.attachPersister(new FileRunStatePersister(repo));

    store.setStatus('n1', 'running');
    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'n1',
      tool: 'Bash',
      summary: 'git push',
      decision: 'denied',
      missingCapability: 'git-write',
    });

    // Read the file back cold — as a post-crash reconciler would.
    const onDisk = readRunState(runFilePath(repo, store.runId));
    expect(onDisk.nodes['n1']!.status).toBe('running');
    expect(onDisk.activity).toHaveLength(1);
    expect(onDisk.activity[0]!.summary).toBe('git push');
    expect(onDisk.activity[0]!.decision).toBe('denied');
    expect(onDisk.nodes['n1']!.denials).toBe(1);
    expect(onDisk.pid).toBe(process.pid);
  });

  it('notifies subscribers on every mutation', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.setStatus('n1', 'running');
    store.setStatus('n1', 'done');
    unsubscribe();
    store.setStatus('n1', 'error');
    expect(calls).toBe(2);
  });

  it('markFinished records whether the run ended via interrupt', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.markFinished(true);
    expect(store.snapshot().interrupted).toBe(true);
    expect(store.snapshot().finishedAt).toBeDefined();
  });

  it('markFinished defaults to not-interrupted', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.markFinished();
    expect(store.snapshot().interrupted).toBe(false);
  });
});

describe('resuming a run', () => {
  it('keeps done nodes as-is and resets everything else, preserving a Discuss transcript and session id', () => {
    const repo = makeTempGitRepo();
    const original = new RunStateStore({ repoRoot: repo, nodeIds: ['a', 'b', 'c'] });
    original.setStatus('a', 'running');
    original.setOutput('a', { summary: 'done work' });
    original.setStatus('a', 'done');
    original.setStatus('b', 'waiting', 'in discussion');
    original.appendDiscussMessage('b', { role: 'assistant', text: 'what should we build?' });
    original.appendDiscussMessage('b', { role: 'user', text: 'a widget' });
    original.setSessionId('b', 'sess-123');
    original.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'a',
      tool: 'Bash',
      summary: 'echo hi',
      decision: 'allowed',
    });
    original.markFinished(true);
    const snapshot = original.snapshot();

    const resumed = new RunStateStore({
      repoRoot: repo,
      nodeIds: ['a', 'b', 'c'],
      resumeFrom: snapshot,
    });
    const state = resumed.snapshot();

    expect(state.runId).toBe(snapshot.runId);
    expect(state.createdAt).toBe(snapshot.createdAt);
    expect(state.finishedAt).toBeUndefined();
    expect(state.interrupted).toBeUndefined();
    expect(state.activity).toHaveLength(1);

    // 'a' finished before the interrupt — kept verbatim.
    expect(state.nodes['a']).toEqual(snapshot.nodes['a']);

    // 'b' was mid-discussion — reset to idle, but the conversation survives.
    expect(state.nodes['b']!.status).toBe('idle');
    expect(state.nodes['b']!.statusDetail).toBeUndefined();
    expect(state.nodes['b']!.discussTranscript).toEqual([
      { role: 'assistant', text: 'what should we build?' },
      { role: 'user', text: 'a widget' },
    ]);
    expect(state.nodes['b']!.sessionId).toBe('sess-123');

    // 'c' never started — plain idle, nothing to carry.
    expect(state.nodes['c']).toEqual({ status: 'idle', denials: 0 });
  });

  it('findLatestInterruptedRun and findInterruptedRun only ever return interrupted runs', () => {
    const repo = makeTempGitRepo();

    const finished = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    finished.attachPersister(new FileRunStatePersister(repo));
    finished.markFinished(false);

    const interrupted = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    interrupted.attachPersister(new FileRunStatePersister(repo));
    interrupted.markFinished(true);

    expect(findInterruptedRun(repo, finished.runId)).toBeUndefined();
    expect(findInterruptedRun(repo, interrupted.runId)?.runId).toBe(interrupted.runId);
    expect(findInterruptedRun(repo, 'no-such-run')).toBeUndefined();
    expect(findLatestInterruptedRun(repo)?.runId).toBe(interrupted.runId);
  });
});
