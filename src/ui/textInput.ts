/**
 * The line-editing keys every text field in the run UI answers to.
 *
 * There are four of them — the discussion composer, the model picker's
 * free-text fallback, the test-command prompt, and the skill picker's search
 * box — and each one is a plain `useState` string with backspace wired to it.
 * That is fine until a typo lands early in a long line, at which point the
 * only recovery is holding backspace. `ctrl+w` and `ctrl+u` are what a shell
 * user already reaches for, they cost one branch each, and routing them
 * through here keeps the four fields agreeing on what they do.
 *
 * Ink reports a ctrl-combo as `key.ctrl` with `input` set to the letter, so
 * these never collide with typed text.
 */

/**
 * Delete back to the start of the word behind the cursor: trailing
 * whitespace first, then the run of non-whitespace before it — readline's
 * `unix-word-rubout`, which is what `ctrl+w` does in a terminal.
 */
export function deleteWordBefore(text: string): string {
  return text.replace(/\S+\s*$|\s+$/, '');
}

/**
 * Apply a line-editing key to `text`, or return null when the key isn't one —
 * so a caller can fall through to its own handling without repeating the
 * modifier checks.
 */
export function applyLineEdit(
  text: string,
  input: string,
  key: { ctrl?: boolean; meta?: boolean },
): string | null {
  if (!key.ctrl || key.meta) return null;
  if (input === 'w') return deleteWordBefore(text);
  if (input === 'u') return '';
  return null;
}
