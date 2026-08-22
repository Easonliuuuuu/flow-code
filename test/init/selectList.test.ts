import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SelectList, windowFor } from '../../src/init/SelectList.js';

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

interface FakeStdout extends NodeJS.WriteStream {
  frames: string[];
}

function fakeStdout(): FakeStdout {
  const frames: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as unknown as FakeStdout;
  Object.assign(out, { columns: 80, rows: 20, isTTY: true, frames });
  return out;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
    ref: () => {},
    unref: () => {},
  });
  return stream;
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The label the cursor (`❯`) is sitting on, with ANSI styling stripped. */
async function highlightedLabel(
  items: { label: string; value: string }[],
  initialIndex?: number,
): Promise<string | undefined> {
  const stdout = fakeStdout();
  const instance = render(
    React.createElement(SelectList<string>, {
      items,
      prompt: 'Pick:',
      ...(initialIndex !== undefined ? { initialIndex } : {}),
      onSelect: () => {},
      onCancel: () => {},
    }),
    { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
  );
  await settle();
  const frame =
    stdout.frames
      .map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))
      .filter((f) => f.trim().length > 0)
      .at(-1) ?? '';
  instance.unmount();
  return frame
    .split('\n')
    .find((line) => line.includes('\u276f'))
    ?.replace('\u276f', '')
    .trim();
}

const ITEMS = [
  { label: 'alpha', value: 'a' },
  { label: 'bravo', value: 'b' },
  { label: 'charlie', value: 'c' },
];

describe('SelectList initialIndex', () => {
  it('starts on the first item when not given one', async () => {
    expect(await highlightedLabel(ITEMS)).toBe('alpha');
  });

  it('starts on the requested item', async () => {
    expect(await highlightedLabel(ITEMS, 2)).toBe('charlie');
  });

  it('clamps past the end rather than highlighting nothing', async () => {
    expect(await highlightedLabel(ITEMS, 99)).toBe('charlie');
  });

  it('clamps a negative index to the top', async () => {
    expect(await highlightedLabel(ITEMS, -3)).toBe('alpha');
  });
});
