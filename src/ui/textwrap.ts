/**
 * Truncate to `width`, marking the cut with an ellipsis. A bare `slice` is
 * what node cards used to do, and it reads as a rendering bug rather than as
 * elided text — `3 acceptance criteri` looks broken in a way `3 acceptance…`
 * does not.
 */
export function fitText(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** Greedy word-wrap, preserving existing newlines as paragraph breaks. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of rawLine.split(/ +/)) {
      let token = word;
      while (token.length > w) {
        if (current.length > 0) {
          lines.push(current);
          current = '';
        }
        lines.push(token.slice(0, w));
        token = token.slice(w);
      }
      if (current.length === 0) {
        current = token;
      } else if (current.length + 1 + token.length <= w) {
        current += ' ' + token;
      } else {
        lines.push(current);
        current = token;
      }
    }
    lines.push(current);
  }
  return lines;
}
