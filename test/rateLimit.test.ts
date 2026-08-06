import { describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/runstate/store.js';
import { rateLimitSegments, rateLimitTone } from '../src/ui/rateLimit.js';
import { makeTempGitRepo } from './helpers.js';

describe('rate-limit meter', () => {
  it('reports nothing when the provider has no plan limits', () => {
    // API-key, Bedrock and Vertex sessions never emit a rate-limit event, and
    // every non-Claude runner has no equivalent. Absent must stay absent —
    // a meter reading 0% would claim a fresh window we know nothing about.
    expect(rateLimitSegments(undefined)).toEqual([]);
    expect(rateLimitSegments({ windows: {}, updatedAt: '2026-08-06T00:00:00.000Z' })).toEqual([]);
  });

  it('renders the shortest window first, whatever order it was reported in', () => {
    const segments = rateLimitSegments({
      windows: {
        seven_day: { utilization: 61, status: 'allowed' },
        five_hour: { utilization: 34, status: 'allowed' },
      },
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(segments.map((s) => s.text)).toEqual(['5h 34%', '7d 61%']);
  });

  it('keeps a window it has never heard of, labelled with its raw id', () => {
    const segments = rateLimitSegments({
      windows: { thirty_day_experimental: { utilization: 5, status: 'allowed' } },
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(segments).toEqual([
      { id: 'thirty_day_experimental', text: 'thirty_day_experimental 5%', tone: 'normal' },
    ]);
  });

  it('escalates on utilization, and on the provider saying so first', () => {
    expect(rateLimitTone(34, 'allowed')).toBe('normal');
    expect(rateLimitTone(75, 'allowed')).toBe('warn');
    expect(rateLimitTone(90, 'allowed')).toBe('critical');
    // The provider's own verdict outranks the thresholds in both directions:
    // a warning at low utilization still warns, and an outright refusal is
    // critical no matter what percentage came with it.
    expect(rateLimitTone(10, 'allowed_warning')).toBe('warn');
    expect(rateLimitTone(10, 'rejected')).toBe('critical');
  });
});

describe('rate-limit run state', () => {
  it('merges windows rather than letting each report evict the last', () => {
    // The five-hour and seven-day windows arrive on separate events, so a
    // replacing write would leave the header flickering between one meter
    // and the other.
    const store = new RunStateStore({ repoRoot: makeTempGitRepo(), nodeIds: ['n1'] });
    store.recordRateLimit('five_hour', { utilization: 34, status: 'allowed' });
    store.recordRateLimit('seven_day', { utilization: 61, status: 'allowed' });
    store.recordRateLimit('five_hour', { utilization: 41, status: 'allowed' });

    expect(store.snapshot().rateLimits?.windows).toEqual({
      five_hour: { utilization: 41, status: 'allowed' },
      seven_day: { utilization: 61, status: 'allowed' },
    });
  });

  it('is absent on a run no provider ever reported for', () => {
    const store = new RunStateStore({ repoRoot: makeTempGitRepo(), nodeIds: ['n1'] });
    expect(store.snapshot().rateLimits).toBeUndefined();
  });
});
