import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HINT_BUDGET } from '../src/ui/App.js';

/**
 * A panel's key hint shares its bottom row with the resize grip, and truncates
 * rather than wrapping — so one that overruns doesn't spill outside the frame,
 * it eats its own last word and butts straight into the grip at the border.
 * That reads as a broken panel, and it is the reason these hints list a handful
 * of keys and leave the rest to the map `?` opens.
 *
 * The hints live inline beside the panels they describe, which is where they
 * belong, so this reads them where they are rather than pulling them out into
 * a table for the sake of being assertable.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../src/ui/App.tsx', import.meta.url)), 'utf8');

/** Every string handed to `PanelFooter`, whether inline or via a ternary. */
function footerHints(): string[] {
  const attributes = [...SOURCE.matchAll(/hint="([^"]+)"/g)].map((m) => m[1]!);
  const expressions = [...SOURCE.matchAll(/hint=\{([\s\S]*?)\n\s*\}/g)].flatMap((m) =>
    [...m[1]!.matchAll(/'([^']*)'/g)].map((s) => s[1]!),
  );
  return [...attributes, ...expressions];
}

describe('panel key hints', () => {
  const hints = footerHints();

  it('finds the hints it is meant to be guarding', () => {
    expect(hints.length).toBeGreaterThan(10);
    expect(hints).toContain('↑/↓/PgUp/PgDn: scroll · ?/esc: close');
  });

  it('fits every one on an 80-column panel row, beside the grip', () => {
    for (const hint of hints) {
      expect([...hint].length, `too long for the footer row: ${hint}`).toBeLessThanOrEqual(
        HINT_BUDGET,
      );
    }
  });
});
