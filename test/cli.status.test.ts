import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announcement,
  attention,
  cmdStatus,
  renderBlock,
  renderLine,
  statusFor,
  summarize,
  type RunSummary,
} from '../src/cli/status.js';
import type { NodeRunState, NodeStatus, RunState } from '../src/runstate/types.js';

const DEAD_PID = 999_999_999;

function node(status: NodeStatus, extra: Partial<NodeRunState> = {}): NodeRunState {
  return { status, denials: 0, ...extra };
}

function stateWith(nodes: Record<string, NodeRunState>, overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'abcdef1234567890',
    createdAt: '2026-08-11T12:00:00.000Z',
    repoRoot: '/repo',
    pid: process.pid,
    baseline: null,
    graph: {
      nodes: Object.keys(nodes).map((id) => ({ id, type: id, config: {} })),
      edges: [],
      settings: { concurrency: 1, subagents: true, budget: { tokensPerRun: 1_000_000, minutesPerRun: 60 } },
    },
    nodes,
    worktrees: [],
    activity: [],
    ...overrides,
  };
}

/** A summary rendered without colour, which is what the width assertions measure. */
function plain(summary: RunSummary, width: number): string {
  return renderLine(summary, { width });
}

describe('summarize', () => {
  it('names a waiting node ahead of one that is running', () => {
    const s = summarize(stateWith({ implement: node('running'), gate: node('waiting') }));
    expect(s.kind).toBe('waiting');
    expect(s.node).toBe('gate');
  });

  it('names a running node ahead of one that errored, since a loop-back may already be retrying it', () => {
    const s = summarize(stateWith({ test: node('error'), implement: node('running') }));
    expect(s.kind).toBe('running');
    expect(s.node).toBe('implement');
  });

  it('names an errored node when nothing is still moving', () => {
    const s = summarize(stateWith({ implement: node('done'), test: node('error', { statusDetail: '2 failing' }) }));
    expect(s.kind).toBe('error');
    expect(s.node).toBe('test');
    expect(s.detail).toBe('2 failing');
  });

  it('reports a finished run as finished rather than naming a node', () => {
    const s = summarize(stateWith({ a: node('done') }, { finishedAt: '2026-08-11T12:30:00.000Z' }));
    expect(s.kind).toBe('finished');
    expect(s.node).toBeUndefined();
  });

  it('distinguishes an interrupted run from a completed one', () => {
    const s = summarize(
      stateWith({ a: node('done') }, { finishedAt: '2026-08-11T12:30:00.000Z', interrupted: true }),
    );
    expect(s.kind).toBe('interrupted');
  });

  it('reports an unfinished run whose driver is gone as no longer driven, not as running', () => {
    const s = summarize(stateWith({ implement: node('running') }, { pid: DEAD_PID }));
    expect(s.kind).toBe('undriven');
    expect(s.node).toBe('implement');
  });

  it('is idle when attached to a live run with nothing started', () => {
    expect(summarize(stateWith({ a: node('idle') })).kind).toBe('idle');
  });

  it('reports no run at all without erroring', () => {
    const s = summarize(undefined);
    expect(s.kind).toBe('none');
    expect(s.total).toBe(0);
  });

  it('counts settled nodes as progress and carries elapsed, attempt and subagents', () => {
    const startedAt = new Date(Date.parse('2026-08-11T12:00:00.000Z') - 74_000).toISOString();
    const s = summarize(
      stateWith({
        discuss: node('done'),
        spec: node('skipped'),
        implement: node('running', { startedAt, attempt: 2, subagents: 1 }),
        test: node('idle'),
      }),
      Date.parse('2026-08-11T12:00:00.000Z'),
    );
    expect(s.done).toBe(2);
    expect(s.total).toBe(4);
    expect(s.elapsedMs).toBe(74_000);
    expect(s.attempt).toBe(2);
    expect(s.subagents).toBe(1);
  });

  it('sums spend and budget for an engine-driven run', () => {
    const tokens = { input: 100, output: 50, cacheWrite: 50, cacheRead: 800 };
    const s = summarize(stateWith({ implement: node('done', { tokens }) }));
    expect(s.tokens).toBe(1000);
    // Budgeted tokens exclude cache reads: 200 of 1,000,000.
    expect(s.budgetPct).toBe(0);
  });
});

describe('summarize — guarantees the run did not carry', () => {
  it('reports spend as unavailable rather than zero for a self-reported run', () => {
    const s = summarize(
      stateWith({ implement: node('done') }, { enforcement: { tier: 'reported' } } as Partial<RunState>),
    );
    expect(s.tier).toBe('reported');
    expect(s.tokens).toBeUndefined();
    expect(s.budgetPct).toBeUndefined();
    expect(plain(s, 120)).toContain('spend n/a');
    expect(plain(s, 120)).not.toContain('0 tok');
  });

  it('reports spend as unavailable when a host-session run recorded none', () => {
    const s = summarize(stateWith({ implement: node('done') }, { enforcement: { tier: 'hooks' } } as Partial<RunState>));
    expect(s.tokens).toBeUndefined();
  });

  it('treats an unrecognized tier as the weakest one rather than trusting it', () => {
    const s = summarize(stateWith({ a: node('done') }, { enforcement: { tier: 'engine-ish' } } as Partial<RunState>));
    expect(s.tier).toBe('reported');
  });

  it('defaults a run document with no tier to engine, which is what every run before tiers was', () => {
    expect(summarize(stateWith({ a: node('done') })).tier).toBe('engine');
  });

  it('names a tier in the rendered line only when it is not engine', () => {
    const guest = summarize(stateWith({ a: node('done') }, { enforcement: { tier: 'hooks' } } as Partial<RunState>));
    expect(plain(guest, 120)).toContain('host session');
    expect(plain(summarize(stateWith({ a: node('done') })), 120)).not.toContain('host session');
  });
});

describe('renderLine — the width ladder', () => {
  const blocked = summarize(
    stateWith({
      discuss: node('done'),
      spec: node('done'),
      implement: node('done'),
      test: node('done'),
      validate: node('done'),
      review: node('done'),
      gate: node('waiting', { statusDetail: 'needs your approval' }),
      'git-ops': node('idle'),
    }),
  );

  it('includes per-node labels when there is room', () => {
    const line = plain(blocked, 140);
    expect(line).toContain('implement');
    expect(line).toContain('git-ops');
  });

  it('drops labels but keeps the blocking node when constrained', () => {
    const line = plain(blocked, 70);
    expect(line).not.toContain('discuss');
    expect(line).toContain('gate needs your approval');
  });

  it('keeps the blocking node and its reason at the narrowest rung', () => {
    const line = plain(blocked, 28);
    expect(line).toContain('gate');
    expect(line).toContain('approval');
  });

  it('never wraps to a second row, at any width', () => {
    for (const width of [200, 140, 100, 70, 40, 28, 12, 5, 1]) {
      expect(plain(blocked, width)).not.toContain('\n');
    }
  });

  it('fits the width it is given, at every rung', () => {
    for (const width of [200, 140, 100, 70, 40, 28, 12, 5, 1]) {
      expect(stringWidth(plain(blocked, width))).toBeLessThanOrEqual(width);
    }
  });

  it('fits the width when node ids and details are double-width characters', () => {
    const wide = summarize(
      stateWith({
        実装: node('done'),
        検証: node('waiting', { statusDetail: '承認をお願いします' }),
      }),
    );
    for (const width of [120, 60, 30, 20, 10, 3]) {
      expect(stringWidth(plain(wide, width))).toBeLessThanOrEqual(width);
    }
  });

  it('renders nothing at all for a zero width rather than overflowing', () => {
    expect(plain(blocked, 0)).toBe('');
  });

  it('says only that there is no run, with no figures to be unavailable about', () => {
    expect(plain(summarize(undefined), 80)).toBe('no run');
  });

  it('colours only when asked', () => {
    expect(renderLine(blocked, { width: 120, color: false })).not.toContain('\x1b[');
    expect(renderLine(blocked, { width: 120, color: true })).toContain('\x1b[');
  });
});

describe('renderBlock', () => {
  const running = summarize(stateWith({ a: node('done'), b: node('running'), c: node('idle') }));

  it('uses a second row for the labelled chain when the terminal is wide', () => {
    const rows = renderBlock(running, { width: 120 });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('a');
    expect(rows[1]).toContain('c');
  });

  it('falls back to one row when there is no room for the chain', () => {
    expect(renderBlock(running, { width: 24 })).toHaveLength(1);
  });
});

describe('attention', () => {
  const waiting = summarize(stateWith({ gate: node('waiting', { statusDetail: 'needs your approval' }) }));

  it('has nothing to announce while a run is simply working', () => {
    expect(attention(summarize(stateWith({ implement: node('running') })))).toBeUndefined();
  });

  it('announces a node that is waiting', () => {
    expect(attention(waiting)?.message).toContain('gate');
  });

  it('announces a run whose driver died', () => {
    expect(attention(summarize(stateWith({ implement: node('running') }, { pid: DEAD_PID })))).toBeDefined();
  });

  it('keeps the same token across repeated checks of the same block', () => {
    const again = summarize(stateWith({ gate: node('waiting', { statusDetail: 'needs your approval' }) }));
    expect(attention(again)?.token).toBe(attention(waiting)?.token);
    expect(announcement(again, attention(waiting)?.token)).toBeUndefined();
  });

  it('announces again when a different node blocks', () => {
    const other = summarize(stateWith({ test: node('error') }));
    expect(announcement(other, attention(waiting)?.token)).toBeDefined();
  });

  it('announces again when a loop-back re-runs the same node', () => {
    const retried = summarize(stateWith({ test: node('error', { attempt: 2 }) }));
    const first = summarize(stateWith({ test: node('error') }));
    expect(announcement(retried, attention(first)?.token)).toBeDefined();
  });
});

describe('statusFor', () => {
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), 'flow-code-status-'));
    mkdirSync(join(dir, '.flow-code', 'runs'), { recursive: true });
    return dir;
  }

  it('reports no run in a directory that has never had one', () => {
    expect(statusFor(project()).kind).toBe('none');
  });

  it('reports no run outside a project entirely', () => {
    expect(statusFor(mkdtempSync(join(tmpdir(), 'flow-code-empty-'))).kind).toBe('none');
  });

  it('finds the project from a subdirectory', () => {
    const dir = project();
    writeFileSync(join(dir, '.flow-code', 'runs', 'r.json'), JSON.stringify(stateWith({ a: node('running') })));
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    expect(statusFor(join(dir, 'src', 'deep')).kind).toBe('running');
  });

  it('renders a half-written document as no run rather than as partial state', () => {
    const dir = project();
    const full = JSON.stringify(stateWith({ a: node('running') }));
    writeFileSync(join(dir, '.flow-code', 'runs', 'r.json'), full.slice(0, full.length / 2));
    expect(statusFor(dir).kind).toBe('none');
  });

  it('renders a document that is valid JSON but not a run as no run', () => {
    const dir = project();
    writeFileSync(join(dir, '.flow-code', 'runs', 'r.json'), '{"hello":"world"}');
    expect(statusFor(dir).kind).toBe('none');
  });

  it('follows whichever run was written most recently', () => {
    const dir = project();
    const runs = join(dir, '.flow-code', 'runs');
    writeFileSync(join(runs, 'old.json'), JSON.stringify(stateWith({ a: node('done') }, { runId: 'old' })));
    writeFileSync(join(runs, 'new.json'), JSON.stringify(stateWith({ a: node('waiting') }, { runId: 'new' })));
    expect(statusFor(dir).runId).toBe('new');
  });

  it('never writes: the run directory is byte-identical after repeated reads', () => {
    const dir = project();
    const runs = join(dir, '.flow-code', 'runs');
    const path = join(runs, 'r.json');
    writeFileSync(path, JSON.stringify(stateWith({ a: node('running') })));
    const before = { files: readdirSync(runs), body: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs };
    for (let i = 0; i < 25; i++) statusFor(dir);
    expect(readdirSync(runs)).toEqual(before.files);
    expect(readFileSync(path, 'utf8')).toBe(before.body);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
  });
});

describe('cmdStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints an idle summary and does not fail outside a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-code-nostatus-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdStatus(['--dir', dir, '--no-color']);
    expect(log.mock.calls.flat().join('\n')).toContain('no run');
  });

  it('prints exactly one row with --line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdStatus(['--dir', mkdtempSync(join(tmpdir(), 'flow-code-line-')), '--line', '--width', '80', '--no-color']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('emits the summary and the announcement token as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-code-json-'));
    mkdirSync(join(dir, '.flow-code', 'runs'), { recursive: true });
    writeFileSync(
      join(dir, '.flow-code', 'runs', 'r.json'),
      JSON.stringify(stateWith({ gate: node('waiting', { statusDetail: 'needs your approval' }) })),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdStatus(['--dir', dir, '--json']);
    const payload = JSON.parse(log.mock.calls.flat().join('')) as {
      summary: RunSummary;
      attention: { token: string } | null;
    };
    expect(payload.summary.node).toBe('gate');
    expect(payload.attention?.token).toBeTruthy();

    // The same call, told what it already announced, has nothing new to say.
    log.mockClear();
    await cmdStatus(['--dir', dir, '--json', '--since', payload.attention?.token ?? '']);
    expect(JSON.parse(log.mock.calls.flat().join('')).attention).toBeNull();
  });

  it('prints a status-bar script that shells back into --line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await cmdStatus(['--script']);
    expect(log).not.toHaveBeenCalled();
    expect(out.mock.calls.flat().join('')).toContain('flow-code status --line');
  });

  it('prints a script that still works on a machine without jq', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await cmdStatus(['--script']);
    const script = out.mock.calls.flat().join('');
    expect(script).toContain('command -v jq');
    expect(script).toContain('python3');
  });
});
