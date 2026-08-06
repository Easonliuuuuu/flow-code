import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../src/runstate/types.js';
import {
  agentKeyOf,
  agentLabelsFor,
  formatActivityRow,
  needsAttribution,
} from '../src/ui/activityRow.js';

const entry = (patch: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ts: '2026-08-06T12:34:56.000Z',
  nodeId: 'n1',
  tool: 'Read',
  summary: 'Read a.ts',
  decision: 'allowed',
  ...patch,
});

describe('activity attribution', () => {
  it('treats a node that ran only its own session as needing no column', () => {
    const entries = [entry(), entry({ tool: 'Bash', summary: 'npm test' })];
    expect(needsAttribution(entries)).toBe(false);
    // No leading label eats into the row when there is nothing to distinguish.
    expect(formatActivityRow(entries[0]!)).toBe(
      `12:34:56  Read     ${'Read a.ts'.padEnd(44)} allowed`,
    );
  });

  it('needs a column as soon as one subagent joins the parent', () => {
    const entries = [entry(), entry({ agentId: 'a1', agentType: 'explore' })];
    expect(needsAttribution(entries)).toBe(true);
  });

  it('labels the parent session distinctly from a subagent', () => {
    const entries = [entry(), entry({ agentId: 'a1', agentType: 'explore' })];
    const labels = agentLabelsFor(entries);
    expect(formatActivityRow(entries[0]!, labels)).toContain('main');
    expect(formatActivityRow(entries[1]!, labels)).toContain('explore');
  });

  it('keeps two Worktree-Agent instances distinguishable', () => {
    // The case that is broken today: instanceId has always been recorded and
    // never read, so a fan-out node's log interleaved with no way to tell whose
    // call was whose.
    const entries = [
      entry({ instanceId: 'alt-1' }),
      entry({ instanceId: 'alt-2', summary: 'Read b.ts' }),
    ];
    expect(needsAttribution(entries)).toBe(true);
    const labels = agentLabelsFor(entries);
    expect(formatActivityRow(entries[0]!, labels)).toContain('alt-1');
    expect(formatActivityRow(entries[1]!, labels)).toContain('alt-2');
  });

  it('disambiguates two subagents of the same type by first appearance', () => {
    const entries = [
      entry({ agentId: 'a1', agentType: 'explore' }),
      entry({ agentId: 'a2', agentType: 'explore' }),
      entry({ agentId: 'a1', agentType: 'explore', summary: 'Read c.ts' }),
    ];
    const labels = agentLabelsFor(entries);
    expect(labels.get('a1')).toBe('explore');
    expect(labels.get('a2')).toBe('explore2');
    // A label is assigned once, so it does not shift as the log grows.
    expect(formatActivityRow(entries[2]!, labels)).toContain('explore ');
  });

  it('reads instanceId and agentId as one vocabulary', () => {
    expect(agentKeyOf(entry({ instanceId: 'alt-1' }))).toBe('alt-1');
    expect(agentKeyOf(entry({ agentId: 'a1' }))).toBe('a1');
    expect(agentKeyOf(entry())).toBeUndefined();
  });

  it('keeps every row the same width so the columns line up', () => {
    const entries = [
      entry(),
      entry({ agentId: 'a1', agentType: 'a-very-long-agent-type' }),
      entry({ instanceId: 'alt-1' }),
    ];
    const labels = agentLabelsFor(entries);
    const prefixes = entries.map((e) => formatActivityRow(e, labels).indexOf('Read     '));
    expect(new Set(prefixes).size).toBe(1);
  });

  it('still renders a denial with its missing capability', () => {
    const row = formatActivityRow(
      entry({ decision: 'denied', missingCapability: 'exec', agentId: 'a1', agentType: 'explore' }),
      agentLabelsFor([entry(), entry({ agentId: 'a1', agentType: 'explore' })]),
    );
    expect(row).toContain('DENIED (exec)');
    expect(row).toContain('explore');
  });
});
