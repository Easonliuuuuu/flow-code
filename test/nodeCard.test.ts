import { describe, expect, it } from 'vitest';
import type { NodeRunState } from '../src/runstate/types.js';
import {
  ellipsis,
  formatDuration,
  formatTokens,
  nodeMetrics,
  nodeSubtitle,
  outcomeSummary,
  plannedSummary,
  spinnerFrame,
  totalTokens,
} from '../src/ui/nodeCard.js';
import { workflowFromYaml } from './helpers.js';

const WF = workflowFromYaml(`
nodes:
  - id: talk
    type: discuss
    config: { topic: What are we building? }
  - id: impl
    type: implement
    config: { instructions: Add a token meter to the run UI }
  - id: check
    type: test
    config: { commands: ["npm test", "npm run lint"] }
  - id: rev
    type: review
  - id: ship
    type: git-ops
    config: { push: { remote: origin, branch: main } }
edges:
  - { from: talk, to: impl }
  - { from: impl, to: check }
  - { from: check, to: rev }
  - { from: rev, to: ship }
`);

const node = (id: string) => WF.nodes.find((n) => n.id === id)!;
const state = (patch: Partial<NodeRunState>): NodeRunState => ({
  status: 'idle',
  denials: 0,
  ...patch,
});

describe('formatting', () => {
  it('abbreviates token counts without losing the order of magnitude', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(48_500)).toBe('49k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });

  it('formats durations compactly across scales', () => {
    expect(formatDuration(4_200)).toBe('4s');
    expect(formatDuration(64_000)).toBe('1m04s');
    expect(formatDuration(7_620_000)).toBe('2h07m');
  });

  it('animates without changing width, so text in front of it never shifts', () => {
    const frames = [0, 3, 6, 9, 12].map(ellipsis);
    expect(new Set(frames.map((f) => f.length)).size).toBe(1);
    expect(frames).toContain('...');
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(1));
    expect(spinnerFrame(10)).toBe(spinnerFrame(0));
  });
});

describe('plannedSummary — what a node will do', () => {
  it('surfaces the interesting config field, never the type name again', () => {
    expect(plannedSummary(node('talk'))).toBe('What are we building?');
    expect(plannedSummary(node('impl'))).toBe('Add a token meter to the run UI');
    expect(plannedSummary(node('check'))).toBe('npm test · npm run lint');
    expect(plannedSummary(node('ship'))).toBe('commit + push → origin/main');
  });

  it('falls back to a description of the job for a node with nothing configured', () => {
    expect(plannedSummary(node('rev'))).toBe('critique the pending diff');
  });
});

describe('outcomeSummary — what a node produced', () => {
  it('headlines each node types own output shape', () => {
    expect(outcomeSummary(node('impl'), { changedFiles: ['a.ts', 'b.ts'], diff: '' })).toBe(
      '2 files changed',
    );
    expect(outcomeSummary(node('check'), { passed: true, commands: [{}, {}] })).toBe(
      '2 commands passed',
    );
    expect(outcomeSummary(node('rev'), { verdict: 'fail', findings: [{}] })).toBe('fail · 1 finding');
    expect(outcomeSummary(node('ship'), { committed: true, pushed: true, remote: 'origin', branch: 'main' })).toBe(
      'pushed → origin/main',
    );
  });

  it('returns null when there is no output to report', () => {
    expect(outcomeSummary(node('impl'), undefined)).toBeNull();
  });
});

describe('nodeSubtitle', () => {
  it('shows the latest tool call while a node is running', () => {
    const subtitle = nodeSubtitle(
      node('impl'),
      state({ status: 'running' }),
      [
        { ts: '', nodeId: 'impl', tool: 'Read', summary: 'src/ui/App.tsx', decision: 'allowed' },
        { ts: '', nodeId: 'impl', tool: 'Edit', summary: 'src/ui/canvas.ts', decision: 'allowed' },
      ],
      0,
    );
    expect(subtitle).toBe('Edit src/ui/canvas.ts');
  });

  it('marks a denied call so a blocked agent is visible on the card itself', () => {
    const subtitle = nodeSubtitle(
      node('impl'),
      state({ status: 'running' }),
      [{ ts: '', nodeId: 'impl', tool: 'Bash', summary: 'git push', decision: 'denied' }],
      0,
    );
    expect(subtitle.startsWith('⚠ Bash git push')).toBe(true);
  });

  it('falls back to an animated thinking line before the first tool call', () => {
    const subtitle = nodeSubtitle(node('impl'), state({ status: 'running' }), [], 0);
    expect(subtitle.trimEnd()).toBe('thinking');
  });

  it('reports the outcome once done and the plan before starting', () => {
    expect(
      nodeSubtitle(node('impl'), state({ status: 'done', output: { changedFiles: ['a.ts'] } }), [], 0),
    ).toBe('1 file changed');
    expect(nodeSubtitle(node('impl'), state({}), [], 0)).toBe('Add a token meter to the run UI');
  });

  it('shows the failure reason on an error', () => {
    expect(nodeSubtitle(node('impl'), state({ status: 'error', statusDetail: 'boom' }), [], 0)).toBe(
      'boom',
    );
  });
});

describe('nodeMetrics', () => {
  const started = '2026-08-03T00:00:00.000Z';
  const now = Date.parse(started) + 64_000;

  it('counts prompt tokens (cached included) against completion tokens, and ticks the clock live', () => {
    const metrics = nodeMetrics(
      state({ status: 'running', startedAt: started, tokens: { input: 8_213, output: 934, cached: 41_200 } }),
      now,
    );
    expect(metrics).toBe('↑49k ↓934 · 1m04s');
  });

  it('freezes the elapsed time once the node has ended', () => {
    const metrics = nodeMetrics(
      state({ status: 'done', startedAt: started, endedAt: new Date(Date.parse(started) + 5_000).toISOString() }),
      now,
    );
    expect(metrics).toBe('5s');
  });

  it('is empty for a node that has not started — there is nothing to measure', () => {
    expect(nodeMetrics(state({}), now)).toBe('');
  });

  it('totals the run for the header', () => {
    expect(
      totalTokens({
        a: state({ tokens: { input: 100, output: 10, cached: 5 } }),
        b: state({ tokens: { input: 1, output: 2, cached: 3 } }),
        c: state({}),
      }),
    ).toBe(121);
  });
});
