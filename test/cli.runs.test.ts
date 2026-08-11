import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRuns, runStatusLabel } from '../src/cli/runs.js';
import { FileRunStatePersister } from '../src/runstate/persist.js';
import { RunStateStore } from '../src/runstate/store.js';
import type { RunState } from '../src/runstate/types.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { recordGraph } from '../src/workflow/record.js';
import { deadOwner, foreignOwner, liveOwner, makeTempGitRepo } from './helpers.js';

function baseState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'abcdef1234567890',
    createdAt: '2026-08-09T12:00:00.000Z',
    repoRoot: '/repo',
    pid: process.pid,
    owner: liveOwner(),
    baseline: null,
    nodes: {},
    worktrees: [],
    activity: [],
    ...overrides,
  };
}

describe('runStatusLabel', () => {
  it('is finished when the run ended cleanly', () => {
    expect(runStatusLabel(baseState({ finishedAt: '2026-08-09T12:01:00.000Z' }))).toBe('finished');
  });

  it('is interrupted when the run ended via ctrl+c/SIGTERM', () => {
    expect(runStatusLabel(baseState({ finishedAt: '2026-08-09T12:01:00.000Z', interrupted: true }))).toBe(
      'interrupted',
    );
  });

  it('is running when unfinished and its pid is still alive', () => {
    expect(runStatusLabel(baseState({ pid: process.pid }))).toBe('running');
  });

  it('is crashed when unfinished and its owner is dead', () => {
    expect(runStatusLabel(baseState({ owner: deadOwner() }))).toBe('crashed');
  });

  it('is unknown when unfinished and the owner belongs to another machine', () => {
    expect(runStatusLabel(baseState({ owner: foreignOwner() }))).toBe('unknown');
  });

  it('is unknown when the document predates ownership, rather than guessing crashed', () => {
    const legacy = baseState();
    delete (legacy as { owner?: unknown }).owner;
    expect(runStatusLabel(legacy)).toBe('unknown');
  });
});

describe('cmdRuns', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no runs recorded in a repo with none', async () => {
    const repo = makeTempGitRepo();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    await cmdRuns();
    cwd.mockRestore();
    expect(spy.mock.calls.flat().join('\n')).toContain('no runs recorded');
  });

  it('lists a persisted run with its id, status, and node tally', async () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['n1', 'n2'] });
    store.attachPersister(new FileRunStatePersister(repo));
    store.setStatus('n1', 'done');
    store.setStatus('n2', 'error');
    store.markFinished(false);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    await cmdRuns();
    cwd.mockRestore();

    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain(store.runId.slice(0, 8));
    expect(output).toContain('finished');
    expect(output).toContain('1 done');
    expect(output).toContain('1 error');
  });

  it('shows the selected graph name for a run that recorded one', async () => {
    const repo = makeTempGitRepo();
    const workflow = loadWorkflowFromString('nodes:\n  - id: n1\n    type: implement\n    config: { instructions: x }\n');
    const store = new RunStateStore({ repoRoot: repo, graph: recordGraph(workflow, 'hardened') });
    store.attachPersister(new FileRunStatePersister(repo));
    store.markFinished(false);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    await cmdRuns();
    cwd.mockRestore();

    expect(spy.mock.calls.flat().join('\n')).toContain('(hardened)');
  });
});
