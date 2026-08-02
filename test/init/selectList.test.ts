import { describe, expect, it } from 'vitest';
import { windowFor } from '../../src/init/SelectList.js';

describe('windowFor', () => {
  it('shows the whole list when it fits within the window', () => {
    expect(windowFor(0, 5, 12)).toEqual({ start: 0, end: 5 });
    expect(windowFor(4, 5, 12)).toEqual({ start: 0, end: 5 });
  });

  it('keeps the cursor centered in the middle of a long list', () => {
    expect(windowFor(50, 100, 12)).toEqual({ start: 44, end: 56 });
  });

  it('clamps to the start when the cursor is near the top', () => {
    expect(windowFor(0, 100, 12)).toEqual({ start: 0, end: 12 });
    expect(windowFor(3, 100, 12)).toEqual({ start: 0, end: 12 });
  });

  it('clamps to the end when the cursor is near the bottom', () => {
    expect(windowFor(99, 100, 12)).toEqual({ start: 88, end: 100 });
    expect(windowFor(96, 100, 12)).toEqual({ start: 88, end: 100 });
  });
});
