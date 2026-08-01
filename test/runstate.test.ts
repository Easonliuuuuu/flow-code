import { describe, expect, it } from 'vitest';
import { FileRunStatePersister, readRunState, runFilePath } from '../src/runstate/persist.js';
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
});
