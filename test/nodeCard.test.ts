import { describe, expect, it } from 'vitest';
import type { NodeRunState } from '../src/runstate/types.js';
import {
  delegationBadge,
  ellipsis,
  formatDuration,
  formatTokens,
  nodeMetrics,
  nodeSubtitle,
  outcomeSummary,
  outputDetailLines,
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
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
    config: { push: { remote: origin, branch: main } }
edges:
  - { from: talk, to: impl }
  - { from: impl, to: check }
  - { from: check, to: rev }
  - { from: rev, to: gate }
  - { from: gate, to: ship }
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

  it('tells a git-ops node given a message apart from one given a house style', () => {
    const gitOps = (config: Record<string, unknown>) => ({
      ...node('ship'),
      config,
    });
    expect(plannedSummary(gitOps({ commitMessage: 'chore: sync' }))).toBe('commit: chore: sync');
    expect(plannedSummary(gitOps({ instructions: 'conventional commits, scope required' }))).toBe(
      'commit: conventional commits, scope required',
    );
    // Neither set is the only case that is really "commit only".
    expect(plannedSummary(gitOps({}))).toBe('commit only');
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

describe('outputDetailLines — the expanded panel breakdown for JSON-only nodes', () => {
  const WF2 = workflowFromYaml(`
nodes:
  - id: talk
    type: discuss
    config: { topic: What are we building? }
  - id: mkspec
    type: spec
  - id: chk
    type: validate
  - id: rev
    type: review
edges:
  - { from: talk, to: mkspec }
  - { from: mkspec, to: chk }
  - { from: chk, to: rev }
`);
  const n2 = (id: string) => WF2.nodes.find((w) => w.id === id)!;

  it('breaks a discussion conclusion into headline and constraint list', () => {
    expect(
      outputDetailLines(n2('talk'), { conclusion: 'Ship it', constraints: ['keep it small'] }),
    ).toEqual(['Conclusion: Ship it', '', 'Constraints:', '- keep it small']);
  });

  it('breaks a spec into title, requirements and acceptance criteria — never raw JSON', () => {
    const lines = outputDetailLines(n2('mkspec'), {
      specPath: '.flow-code/specs/r1.md',
      title: 'Add retries',
      requirements: ['must be idempotent'],
      acceptanceCriteria: [{ id: 'AC1', text: 'retries on 5xx' }],
    })!;
    expect(lines).toContain('Title: Add retries');
    expect(lines).toContain('- AC1 — retries on 5xx');
    expect(lines.join('\n')).not.toContain('{');
  });

  it('breaks a validate verdict into per-criterion checkmarks', () => {
    const lines = outputDetailLines(n2('chk'), {
      verdict: 'fail',
      notes: '1 unmet',
      criteria: [{ id: 'AC1', met: false, evidence: 'no retry logic found' }],
    })!;
    expect(lines).toContain('Verdict: fail');
    expect(lines).toContain('- [ ] AC1 — no retry logic found');
  });

  it('breaks review findings into a severity-tagged list', () => {
    const lines = outputDetailLines(n2('rev'), {
      verdict: 'fail',
      findings: [{ location: 'a.ts:10', description: 'off by one', severity: 'major' }],
    })!;
    expect(lines).toContain('Findings (1):');
    expect(lines).toContain('- [major] a.ts:10 — off by one');
  });

  it('returns null rather than a half-built view when output does not match the shape yet', () => {
    expect(outputDetailLines(n2('mkspec'), undefined)).toBeNull();
    expect(outputDetailLines(n2('mkspec'), { unrelated: true })).toBeNull();
  });

  it('leaves non-JSON-only node types alone, since their transcript is already readable', () => {
    expect(outputDetailLines(node('impl'), { changedFiles: [], diff: '', summary: 'done' })).toBeNull();
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

  it('keeps a blocked count on the card after the node finishes', () => {
    // Under the `hooks` tier a denial is the only activity a run records, so a
    // finished node that swaps it for success text hides the run's sole
    // evidence exactly when someone goes looking for it.
    const subtitle = nodeSubtitle(
      node('impl'),
      state({ status: 'done', output: { changedFiles: ['a.ts'] }, denials: 4 }),
      [],
      0,
    );
    expect(subtitle).toContain('1 file changed');
    expect(subtitle).toContain('4 blocked');
  });

  it('says nothing about blocking on a node that was never blocked', () => {
    expect(
      nodeSubtitle(node('impl'), state({ status: 'done', output: { changedFiles: ['a.ts'] } }), [], 0),
    ).toBe('1 file changed');
  });

  it('shows the failure reason on an error', () => {
    expect(nodeSubtitle(node('impl'), state({ status: 'error', statusDetail: 'boom' }), [], 0)).toBe(
      'boom',
    );
  });

  it('elides to the width the card actually has, marking the cut', () => {
    const detail = 'node token budget exhausted: 12000 tokens spent of 10000 allowed';
    const narrow = nodeSubtitle(node('impl'), state({ status: 'error', statusDetail: detail }), [], 0, 20);
    expect(narrow.length).toBeLessThanOrEqual(20);
    expect(narrow.endsWith('…')).toBe(true);
    // A wider card is given the whole line rather than the old fixed 44.
    expect(nodeSubtitle(node('impl'), state({ status: 'error', statusDetail: detail }), [], 0, 80)).toBe(
      detail,
    );
  });

  it('keeps the tool name of a running node and elides its argument, not the reverse', () => {
    const subtitle = nodeSubtitle(
      node('impl'),
      state({ status: 'running' }),
      [{ ts: '', nodeId: 'impl', tool: 'Edit', summary: 'src/ui/some/deeply/nested/file.ts', decision: 'allowed' }],
      0,
      20,
    );
    expect(subtitle.startsWith('Edit ')).toBe(true);
    expect(subtitle.endsWith('…')).toBe(true);
  });
});

describe('nodeMetrics', () => {
  const started = '2026-08-03T00:00:00.000Z';
  const now = Date.parse(started) + 64_000;

  it('counts prompt tokens (cached included) against completion tokens, and ticks the clock live', () => {
    const metrics = nodeMetrics(
      state({ status: 'running', startedAt: started, tokens: { input: 8_213, output: 934, cacheRead: 41_200, cacheWrite: 0 } }),
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

  it('marks a node that is delegating right now, and only while it is', () => {
    expect(delegationBadge(state({ subagents: 2 }))).toBe(' ⑂2');
    // In flight, not a tally: a node that finished its subagents is back to
    // showing nothing.
    expect(delegationBadge(state({ subagents: 0 }))).toBe('');
    expect(delegationBadge(state({}))).toBe('');
  });

  it('totals the run for the header', () => {
    expect(
      totalTokens({
        a: state({ tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0 } }),
        b: state({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } }),
        c: state({}),
      }),
    ).toBe(121);
  });
});
