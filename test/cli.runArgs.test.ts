import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRunSummary, parseGraphArg, parseResumeArg, runExitCode } from '../src/cli/run.js';
import type { NodeRunState, NodeStatus } from '../src/runstate/types.js';

/** Makes `fail`'s process.exit observable rather than killing the test runner. */
function trapExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exit, error };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('accepts -r as a shorthand for --resume', () => {
    expect(parseResumeArg(['-r'])).toEqual({ resuming: true });
    expect(parseResumeArg(['-r', 'abc123'])).toEqual({ resuming: true, runId: 'abc123' });
    expect(parseResumeArg(['-r', '--allow-dirty'])).toEqual({ resuming: true });
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

  it('is 1 when a gate was rejected, which completes rather than errors', () => {
    const rejected = {
      ...nodes('done'),
      gate: {
        status: 'done' as const,
        denials: 0,
        output: { decision: 'rejected', decidedAt: '2026-08-15T00:00:00.000Z' },
      },
    };
    expect(runExitCode(rejected, false)).toBe(1);
  });

  it('is 0 when that same gate was approved', () => {
    const approved = {
      ...nodes('done'),
      gate: {
        status: 'done' as const,
        denials: 0,
        output: { decision: 'approved', decidedAt: '2026-08-15T00:00:00.000Z' },
      },
    };
    expect(runExitCode(approved, false)).toBe(0);
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

describe('parseGraphArg', () => {
  it('is undefined when the flag is absent', () => {
    expect(parseGraphArg([])).toBeUndefined();
    expect(parseGraphArg(['--allow-dirty'])).toBeUndefined();
  });

  it('takes the following argument as the graph name', () => {
    expect(parseGraphArg(['--graph', 'hardened'])).toBe('hardened');
  });

  it('exits when the flag is given with no name', () => {
    const { error } = trapExit();
    expect(() => parseGraphArg(['--graph'])).toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('requires a graph name'));
  });

  it('exits rather than mistaking a following flag for a name', () => {
    const { error } = trapExit();
    expect(() => parseGraphArg(['--graph', '--allow-dirty'])).toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('requires a graph name'));
  });
});
