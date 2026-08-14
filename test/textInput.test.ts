import { describe, expect, it } from 'vitest';
import { applyLineEdit, deleteWordBefore } from '../src/ui/textInput.js';

describe('deleteWordBefore', () => {
  it('takes the word behind the cursor, and the space it was sitting on', () => {
    expect(deleteWordBefore('npm run buildd')).toBe('npm run ');
    expect(deleteWordBefore('npm run build ')).toBe('npm run ');
  });

  it('eats a run of trailing whitespace on its own rather than a whole word with it', () => {
    expect(deleteWordBefore('npm test   ')).toBe('npm ');
  });

  it('empties a one-word line, and leaves an empty one empty', () => {
    expect(deleteWordBefore('build')).toBe('');
    expect(deleteWordBefore('')).toBe('');
    expect(deleteWordBefore('   ')).toBe('');
  });
});

describe('applyLineEdit', () => {
  it('is ctrl+w and ctrl+u, and nothing else', () => {
    expect(applyLineEdit('npm run build', 'w', { ctrl: true })).toBe('npm run ');
    expect(applyLineEdit('npm run build', 'u', { ctrl: true })).toBe('');
    expect(applyLineEdit('npm run build', 'a', { ctrl: true })).toBeNull();
  });

  it('declines a bare keystroke, so a typed `w` stays a typed `w`', () => {
    expect(applyLineEdit('build', 'w', {})).toBeNull();
    expect(applyLineEdit('build', 'u', { ctrl: false })).toBeNull();
  });

  it('declines a meta combo, which the terminal means for something else', () => {
    expect(applyLineEdit('build', 'w', { ctrl: true, meta: true })).toBeNull();
  });
});
