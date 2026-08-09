import { describe, expect, it } from 'vitest';
import { formatRunSummary, parseResumeArg, runExitCode } from '../src/cli/run.js';
import type { NodeRunState, NodeStatus } from '../src/runstate/types.js';

function nodes(...statuses: NodeStatus[]): Record<string, NodeRunState> {
  return Object.fromEntries(statuses.map((status, i) => [`n${i}`, { status, denials: 0 }]));
}

describe('parseResumeArg', () => {
  it('reports no resume when the flag is absent', () => {
    expect(parseResumeArg([])).toEqual({ resuming: false });
    expect(parseResumeArg(['--allow-dirty'])).toEqual({ resuming: false });
  });

  it('resumes the most recent run when the flag stands alone', () => {
    expect(parseResumeArg(['--resume'])).toEqual({ resuming: true });
  });

  it('takes the following argument as the run id', () => {
    expect(parseResumeArg(['--resume', 'abc123'])).toEqual({ resuming: true, runId: 'abc123' });
  });

  it('does not mistake a following flag for a run id', () => {
    // `run --resume --allow-dirty` resumes the latest run; it does not go
    // looking for one called `--allow-dirty`.
    expect(parseResumeArg(['--resume', '--allow-dirty'])).toEqual({ resuming: true });
    expect(parseResumeArg(['--resume', '--no-splash'])).toEqual({ resuming: true });
  });
});

describe('runExitCode', () => {
  it('is 130 for an interrupt, whatever the nodes did', () => {
    expect(runExitCode(nodes('done', 'done'), true)).toBe(130);
    expect(runExitCode(nodes('error'), true)).toBe(130);
  });

  it('is 1 when any node errored', () => {
    expect(runExitCode(nodes('done', 'error', 'done'), false)).toBe(1);
  });

  it('is 0 when the run completed with no errors', () => {
    expect(runExitCode(nodes('done', 'done', 'skipped'), false)).toBe(0);
    expect(runExitCode({}, false)).toBe(0);
  });
});

describe('formatRunSummary', () => {
  it('shortens the run id and tallies nodes by status', () => {
    const summary = formatRunSummary('0123456789abcdef', nodes('done', 'done', 'error'), false);
    expect(summary).toBe('flow-code: run 01234567 finished — 2 done, 1 error');
  });

  it('says interrupted rather than finished when the run was aborted', () => {
    expect(formatRunSummary('abcdefgh1234', nodes('done'), true)).toContain('interrupted');
  });
});
