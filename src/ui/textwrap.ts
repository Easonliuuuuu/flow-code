import stringWidth from 'string-width';

/**
 * Grapheme-cluster segmenter, shared across calls. `Intl.Segmenter` groups
 * ZWJ sequences, variation selectors, and skin-tone modifiers into a single
 * cluster, so an emoji built from several code points is never split apart
 * when we walk the string one visual unit at a time.
 */
const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Split `text` into display units (grapheme clusters where available). */
function graphemes(text: string): string[] {
  if (segmenter) {
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** On-screen column width of `text` (wide CJK/emoji count as 2, not 1). */
export function columnWidth(text: string): number {
  return stringWidth(text);
}

/**
 * Truncate to `width` display columns, marking the cut with an ellipsis. A
 * bare `slice` is what node cards used to do, and it reads as a rendering
 * bug rather than as elided text — `3 acceptance criteri` looks broken in a
 * way `3 acceptance…` does not. Width is measured in on-screen columns via
 * `string-width`, not `string.length`, so wide CJK characters and emoji
 * don't overflow the box they're rendered in.
 */
export function fitText(text: string, width: number): string {
  if (width <= 0) return '';
  if (columnWidth(text) <= width) return text;
  if (width === 1) return '…';

  const budget = width - 1; // reserve one column for the ellipsis
  let result = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const w = columnWidth(cluster);
    if (used + w > budget) break;
    result += cluster;
    used += w;
  }
  return `${result}…`;
}

/**
 * Split `token` into a head that fits within `width` columns, and the rest.
 * Never splits a grapheme cluster in half: a single wide character whose
 * column pair wouldn't fit is still emitted whole (as its own head) rather
 * than corrupted, even though that head then exceeds `width` by one column.
 */
function splitByWidth(token: string, width: number): [string, string] {
  const clusters = graphemes(token);
  let head = '';
  let used = 0;
  let i = 0;
  for (; i < clusters.length; i++) {
    const cluster = clusters[i] ?? '';
    const w = columnWidth(cluster);
    if (used + w > width) break;
    head += cluster;
    used += w;
  }
  if (i === 0 && clusters.length > 0) {
    // The very first cluster alone is already wider than the budget (e.g. a
    // double-width character with width === 1). Emit it whole to guarantee
    // forward progress and avoid splitting its column pair.
    head = clusters[0] ?? '';
    i = 1;
  }
  return [head, clusters.slice(i).join('')];
}

/** Greedy word-wrap by display column, preserving existing newlines as paragraph breaks. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    for (const word of rawLine.split(/ +/)) {
      let token = word;
      let tokenWidth = columnWidth(token);
      while (tokenWidth > w) {
        if (current.length > 0) {
          lines.push(current);
          current = '';
          currentWidth = 0;
        }
        const [head, rest] = splitByWidth(token, w);
        lines.push(head);
        token = rest;
        tokenWidth = columnWidth(token);
      }
      if (current.length === 0) {
        current = token;
        currentWidth = tokenWidth;
      } else if (currentWidth + 1 + tokenWidth <= w) {
        current += ' ' + token;
        currentWidth += 1 + tokenWidth;
      } else {
        lines.push(current);
        current = token;
        currentWidth = tokenWidth;
      }
    }
    lines.push(current);
  }
  return lines;
}
