import type { ActivityEntry } from '../runstate/types.js';

/**
 * Rows of a node's activity log. Pure, because the interesting part — telling
 * several agents under one node apart — is a property of the whole set of
 * entries rather than of any one row, and that is worth testing directly.
 */

/**
 * Stable identity of the agent that produced an entry, or undefined for the
 * node's own session. Worktree-Agent instances and subagents are deliberately
 * one vocabulary here: from the reader's side both answer "who, inside this
 * node, did this", and a node never has both.
 */
export function agentKeyOf(entry: ActivityEntry): string | undefined {
  return entry.instanceId ?? entry.agentId;
}

/** What the parent session's rows are labelled when anything else shares the log. */
export const MAIN_AGENT_LABEL = 'main';

/** Longest label rendered; anything longer is truncated to fit the column. */
const MAX_LABEL = 8;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Short label per agent, in first-appearance order.
 *
 * A subagent is labelled by its type rather than its opaque id, since the type
 * is what a reader can act on. Two agents of the same type would collide, so
 * repeats get an ordinal (`explore`, `explore2`) — assigned by first
 * appearance, so the label of a given agent never changes as the log grows.
 */
export function agentLabelsFor(entries: ActivityEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  const usedPerType = new Map<string, number>();
  for (const entry of entries) {
    const key = agentKeyOf(entry);
    if (key === undefined || labels.has(key)) continue;
    const base = entry.agentType ?? key;
    const seen = (usedPerType.get(base) ?? 0) + 1;
    usedPerType.set(base, seen);
    labels.set(key, truncate(seen === 1 ? base : `${base}${seen}`, MAX_LABEL));
  }
  return labels;
}

/**
 * True when a node's log came from more than one agent — the only case where
 * an attribution column distinguishes anything. The node's own session counts
 * as one agent, so a node that spawned a single subagent still qualifies.
 */
export function needsAttribution(entries: ActivityEntry[]): boolean {
  const keys = new Set<string | undefined>();
  for (const entry of entries) {
    keys.add(agentKeyOf(entry));
    if (keys.size > 1) return true;
  }
  return false;
}

/**
 * One row. `labels` is empty when the node ran a single agent, which is what
 * drops the column entirely rather than padding every row with blanks.
 */
export function formatActivityRow(
  entry: ActivityEntry,
  labels: Map<string, string> = new Map(),
): string {
  const time = entry.ts.slice(11, 19);
  const summary = entry.summary.length > 42 ? `${entry.summary.slice(0, 42)}…` : entry.summary;
  const decision =
    entry.decision === 'denied' ? `DENIED (${entry.missingCapability ?? '?'})` : 'allowed';
  const exit =
    entry.exitStatus !== undefined && entry.exitStatus !== null ? ` exit ${entry.exitStatus}` : '';
  const duration = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
  const key = agentKeyOf(entry);
  const agent =
    labels.size > 0
      ? `${(key !== undefined ? (labels.get(key) ?? key) : MAIN_AGENT_LABEL).padEnd(MAX_LABEL)}  `
      : '';
  return `${time}  ${agent}${entry.tool.padEnd(8)} ${summary.padEnd(44)} ${decision}${exit}${duration}`;
}
