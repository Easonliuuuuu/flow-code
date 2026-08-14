import { describe, expect, it } from 'vitest';
import { helpKeyWidth, helpRows } from '../src/ui/help.js';

/**
 * The key map is data, so the parts of it that have to hold — every key
 * described exactly once, a column wide enough for the widest of them, and a
 * `watch` variant that says the node-editing keys are off — are assertable
 * without mounting a terminal.
 */

describe('helpRows', () => {
  const rows = helpRows();
  const bindings = rows.filter((r) => r.kind === 'binding');

  it('groups every binding under a section, blank-separated', () => {
    expect(rows[0]!.kind).toBe('title');
    expect(bindings.length).toBeGreaterThan(15);
    // A blank never leads, never trails, and never doubles.
    expect(rows.at(-1)!.kind).toBe('binding');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.kind === 'blank') expect(rows[i + 1]!.kind).toBe('title');
    }
  });

  it('describes each key once — two rows claiming the same key is how a key map goes stale', () => {
    const keys = bindings.map((r) => (r.kind === 'binding' ? r.keys : ''));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers the keys the hint line has no room for', () => {
    const keys = bindings.flatMap((r) => (r.kind === 'binding' ? [r.keys] : []));
    for (const key of ['ctrl+p', 'PgUp / PgDn', 'ctrl+w', 'a / r']) {
      expect(keys).toContain(key);
    }
  });

  it('says the per-node keys are disabled while watching, since watch refuses them', () => {
    const titles = helpRows({ watch: true }).flatMap((r) => (r.kind === 'title' ? [r.text] : []));
    expect(titles.some((t) => t.includes('watching'))).toBe(true);
    expect(helpRows().every((r) => r.kind !== 'title' || !r.text.includes('watching'))).toBe(true);
  });
});

describe('helpKeyWidth', () => {
  it('is the widest key column in the rows actually being drawn', () => {
    const rows = helpRows();
    const widest = Math.max(...rows.map((r) => (r.kind === 'binding' ? r.keys.length : 0)));
    expect(helpKeyWidth(rows)).toBe(widest);
  });

  it('is zero for rows with no bindings in them at all', () => {
    expect(helpKeyWidth([{ kind: 'title', text: 'nothing' }])).toBe(0);
  });
});
