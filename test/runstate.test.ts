import { describe, expect, it } from 'vitest';
import {
  FileRunStatePersister,
  findInterruptedRun,
  findLatestInterruptedRun,
  readRunState,
  runFilePath,
} from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import { budgetedTokens, promptTokens, sumTokens } from '../src/runstate/types.js';
import type { TokenUsage } from '../src/runstate/types.js';
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

  it('round-trips agent attribution through the run file', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.attachPersister(new FileRunStatePersister(repo));

    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'n1',
      agentId: 'a1',
      agentType: 'explore',
      tool: 'Read',
      summary: 'Read a.ts',
      decision: 'allowed',
    });
    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'n1',
      tool: 'Read',
      summary: 'Read b.ts',
      decision: 'allowed',
    });

    const onDisk = readRunState(runFilePath(repo, store.runId));
    expect(onDisk.activity[0]!.agentId).toBe('a1');
    expect(onDisk.activity[0]!.agentType).toBe('explore');
    // An entry from the node's own session carries no attribution at all,
    // rather than a placeholder that would have to be special-cased on read.
    expect(onDisk.activity[1]!.agentId).toBeUndefined();
    expect('agentId' in onDisk.activity[1]!).toBe(false);
  });

  it('reads a run file written before attribution existed', () => {
    // Entries from an older version have no agent fields; they mean "the
    // node's own session", which is exactly how an absent field already reads.
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.attachPersister(new FileRunStatePersister(repo));
    store.appendActivity({
      ts: '2026-01-01T00:00:00.000Z',
      nodeId: 'n1',
      tool: 'Bash',
      summary: 'npm test',
      decision: 'allowed',
      durationMs: 12,
      exitStatus: 0,
    });

    const onDisk = readRunState(runFilePath(repo, store.runId));
    expect(onDisk.activity).toHaveLength(1);
    expect(onDisk.activity[0]!.summary).toBe('npm test');
    expect(onDisk.activity[0]!.agentId).toBeUndefined();
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

describe('token accounting', () => {
  const usage = { input: 100, output: 20, cacheRead: 900_000, cacheWrite: 5_000 };

  it('reports every token moved, and budgets everything but cache reads', () => {
    expect(sumTokens(usage)).toBe(905_120);
    expect(budgetedTokens(usage)).toBe(5_120);
    expect(promptTokens(usage)).toBe(905_100);
  });

  it('reads a pre-split run file as cache reads, so an old run is not retroactively over budget', () => {
    // Written before the two cache terms were separated: one `cached` field.
    const legacy = { input: 100, output: 20, cached: 900_000 } as unknown as TokenUsage;
    expect(sumTokens(legacy)).toBe(900_120);
    expect(budgetedTokens(legacy)).toBe(120);
  });

  it('counts nothing for a node that never ran a session', () => {
    expect(sumTokens(undefined)).toBe(0);
    expect(budgetedTokens(undefined)).toBe(0);
  });
});

describe('token and timing tracking', () => {
  it('accumulates token deltas as a session reports them', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    expect(store.node('n1').tokens).toBeUndefined();
    store.addTokens('n1', { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 });
    store.addTokens('n1', { input: 50, output: 10 });
    expect(store.node('n1').tokens).toEqual({ input: 150, output: 30, cacheRead: 5, cacheWrite: 0 });
  });

  it('stamps startedAt once and endedAt on the terminal status', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.setStatus('n1', 'running');
    const startedAt = store.node('n1').startedAt;
    expect(startedAt).toBeDefined();
    expect(store.node('n1').endedAt).toBeUndefined();
    // A mid-run detail update must not restart the clock.
    store.setStatus('n1', 'running', 'still working');
    expect(store.node('n1').startedAt).toBe(startedAt);
    store.setStatus('n1', 'done');
    expect(store.node('n1').endedAt).toBeDefined();
  });

  it('restarts the clock on a loop-back reset but keeps the tokens already spent', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.setStatus('n1', 'running');
    store.addTokens('n1', { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    store.setStatus('n1', 'error', 'boom');

    store.resetNode('n1');

    expect(store.node('n1').startedAt).toBeUndefined();
    expect(store.node('n1').endedAt).toBeUndefined();
    // Tokens are what the node has already cost — a retry adds to that bill.
    expect(store.node('n1').tokens).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('status detail', () => {
  it('drops a detail the previous status set, rather than carrying it into the next', () => {
    // The Test node's shape exactly: it waits for a command it doesn't have,
    // is given one, runs it, and passes. Reporting "no test command set yet"
    // on a node that just ran the suite is worse than reporting nothing.
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['test'] });
    store.setStatus('test', 'waiting', 'no test command set yet');
    store.setStatus('test', 'running');
    expect(store.node('test').statusDetail).toBeUndefined();
    store.setStatus('test', 'done');
    expect(store.node('test').statusDetail).toBeUndefined();
  });

  it('keeps a detail across an update that does not change the status', () => {
    // running → running is an executor refining what it is doing; the line it
    // wrote a moment ago is still the truth.
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.setStatus('n1', 'running', 'installing dependencies');
    store.setStatus('n1', 'running');
    expect(store.node('n1').statusDetail).toBe('installing dependencies');
  });

  it('replaces the detail when the new status brings one', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.setStatus('n1', 'running', 'working');
    store.setStatus('n1', 'error', 'boom');
    expect(store.node('n1').statusDetail).toBe('boom');
  });

  it('leaves no orphaned key behind on disk', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.attachPersister(new FileRunStatePersister(repo));
    store.setStatus('n1', 'waiting', 'waiting for you');
    store.setStatus('n1', 'done');

    const onDisk = readRunState(runFilePath(repo, store.runId));
    expect('statusDetail' in onDisk.nodes['n1']!).toBe(false);
  });
});

describe('attempt tracking', () => {
  it('reports a first attempt for a node that has never been reset', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    expect(store.attemptOf('n1')).toBe(1);
    expect(store.node('n1').priorAttempts).toBeUndefined();
  });

  it('reset clears results and increments the attempt, keeping the outcome', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.setStatus('n1', 'running');
    store.setOutput('n1', { verdict: 'fail' });
    store.appendLiveOutput('n1', 'streamed text');
    store.setStatus('n1', 'error', 'Validate verdict: fail');

    store.resetNode('n1');

    const node = store.node('n1');
    expect(node.status).toBe('idle');
    expect(node.output).toBeUndefined();
    expect(node.statusDetail).toBeUndefined();
    expect(store.liveOutputFor('n1')).toBe('');
    expect(store.attemptOf('n1')).toBe(2);
    expect(node.priorAttempts).toHaveLength(1);
    expect(node.priorAttempts![0]!.status).toBe('error');
    expect(node.priorAttempts![0]!.detail).toBe('Validate verdict: fail');
  });

  it('retains the activity log across a reset', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'n1',
      tool: 'Bash',
      summary: 'npm test',
      decision: 'allowed',
    });
    store.setStatus('n1', 'error', 'boom');
    store.resetNode('n1');
    // The log is the record of what actually ran, across every attempt.
    expect(store.activityFor('n1')).toHaveLength(1);
  });

  it('accumulates one record per attempt', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.setStatus('n1', 'error', 'first');
    store.resetNode('n1');
    store.setStatus('n1', 'error', 'second');
    store.resetNode('n1');
    expect(store.attemptOf('n1')).toBe(3);
    expect(store.node('n1').priorAttempts!.map((a) => a.detail)).toEqual(['first', 'second']);
  });

  it('persists and reloads attempt counters', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'] });
    store.attachPersister(new FileRunStatePersister(repo));
    store.setStatus('n1', 'error', 'boom');
    store.resetNode('n1');
    const reloaded = readRunState(runFilePath(repo, store.runId))!;
    expect(reloaded.nodes['n1']!.attempt).toBe(2);
    expect(reloaded.nodes['n1']!.priorAttempts).toHaveLength(1);
  });

  it('reads run-state written before attempt tracking as a first attempt', () => {
    const repo = makeTempGitRepo();
    // No `attempt` field, as an older run-state file would have.
    const prior = {
      runId: 'old-run',
      createdAt: new Date().toISOString(),
      repoRoot: repo,
      pid: 1,
      baseline: null,
      nodes: { n1: { status: 'error' as const, denials: 0 } },
      worktrees: [],
      activity: [],
      interrupted: true,
    };
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1'], resumeFrom: prior });
    expect(store.attemptOf('n1')).toBe(1);
  });
});
