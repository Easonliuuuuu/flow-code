import type { RateLimits } from '../runstate/types.js';

/**
 * The header's plan-usage meter. Pure, so the thresholds that decide when a
 * meter turns yellow are testable without rendering a frame.
 */

/**
 * Short labels for the windows the provider reports. Rendering falls back to
 * the raw id for anything not listed, so a new window shows up as an ugly
 * meter rather than as no meter.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d opus',
  seven_day_sonnet: '7d sonnet',
  seven_day_overage_included: '7d ovg',
  overage: 'overage',
};

/** Shortest window first, so the meter most likely to bite is read first. */
const WINDOW_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

export type RateLimitTone = 'normal' | 'warn' | 'critical';

export interface RateLimitSegment {
  /** Window id, unique per segment — usable as a render key. */
  id: string;
  /** `5h 34%` — short enough to survive the header's single truncating row. */
  text: string;
  tone: RateLimitTone;
}

/**
 * A window is critical once the provider has actually started refusing, or at
 * 90% — the point where a long run is likely to hit the wall before it
 * finishes. Warn tracks the provider's own `allowed_warning`, with a 75%
 * floor so the meter turns before the provider bothers to say anything.
 */
export function rateLimitTone(utilization: number, status: string): RateLimitTone {
  if (status === 'rejected' || utilization >= 90) return 'critical';
  if (status === 'allowed_warning' || utilization >= 75) return 'warn';
  return 'normal';
}

function orderOf(id: string): number {
  const index = WINDOW_ORDER.indexOf(id);
  // Unknown windows sort after the known ones, alphabetically among themselves.
  return index === -1 ? WINDOW_ORDER.length : index;
}

/** One segment per window the provider has reported; empty when it reports none. */
export function rateLimitSegments(limits: RateLimits | undefined): RateLimitSegment[] {
  if (!limits) return [];
  return Object.entries(limits.windows)
    .sort(([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b))
    .map(([id, window]) => ({
      id,
      text: `${WINDOW_LABELS[id] ?? id} ${Math.round(window.utilization)}%`,
      tone: rateLimitTone(window.utilization, window.status),
    }));
}
