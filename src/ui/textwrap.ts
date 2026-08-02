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
