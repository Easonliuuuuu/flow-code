import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  AUTO_DONE_FRAME,
  WORDMARK_LINE_COUNT,
  WORDMARK_START,
  Splash,
  captionAt,
  wordmarkLinesAt,
} from '../src/ui/splash.js';

/**
 * The startup splash's frame math (`stateAt`/`RUNS`/`AUTO_DONE_FRAME`) and
 * its skip conditions had no automated coverage — only the by-hand column
 * arithmetic in the component itself. These tests exercise both: that it
 * actually plays through the fail/retry chain to the wordmark and calls
 * `onDone` once, that the wordmark reveals line-by-line and settles on a
 * green "ready", and that every skip path (keypress, narrow terminal, no
 * TTY) bails out immediately instead of waiting out the timer.
 */

const ROWS = 20;
const COLUMNS = 80;

interface FakeStdout extends NodeJS.WriteStream {
  frames: string[];
}

function fakeStdout(opts: { columns?: number; isTTY?: boolean } = {}): FakeStdout {
  const frames: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as unknown as FakeStdout;
  Object.assign(out, {
    columns: opts.columns ?? COLUMNS,
    rows: ROWS,
    isTTY: opts.isTTY ?? true,
    frames,
  });
  return out;
}

function fakeStdin(opts: { isTTY?: boolean } = {}): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stream, {
    isTTY: opts.isTTY ?? true,
    setRawMode: () => stream,
    ref: () => {},
    unref: () => {},
  });
  return stream;
}

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastFrame(stdout: FakeStdout): string {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return plain.filter((f) => f.trim().length > 0).at(-1) ?? '';
}

function mountSplash(
  onDone: () => void,
  opts: { stdoutColumns?: number; stdoutTTY?: boolean; stdinTTY?: boolean } = {},
): { stdout: FakeStdout; stdin: NodeJS.ReadStream; unmount: () => void } {
  const stdout = fakeStdout({
    ...(opts.stdoutColumns !== undefined ? { columns: opts.stdoutColumns } : {}),
    ...(opts.stdoutTTY !== undefined ? { isTTY: opts.stdoutTTY } : {}),
  });
  const stdin = fakeStdin({ ...(opts.stdinTTY !== undefined ? { isTTY: opts.stdinTTY } : {}) });
  const instance = render(React.createElement(Splash, { onDone }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  return { stdout, stdin, unmount: () => instance.unmount() };
}

describe('Splash', () => {
  it('plays through the fail/retry chain and calls onDone exactly once', async () => {
    let doneCount = 0;
    const { stdout, unmount } = mountSplash(() => {
      doneCount += 1;
    });

    // Mid-animation: the chain is still running, the wordmark hasn't shown
    // yet, and nothing has finished.
    await settle(400);
    expect(lastFrame(stdout)).not.toContain('flow-code');
    expect(doneCount).toBe(0);

    // The fourth node's failure and the retry caption both appear along the
    // way (D_END is frame 8 / 1280ms, D2_END is frame 16 / 2560ms).
    await settle(1600);
    expect(lastFrame(stdout)).toMatch(/failed|retrying/);

    // Past AUTO_DONE_FRAME (28 frames * 160ms = 4480ms): settled and done.
    await settle(4000);
    const frame = lastFrame(stdout);
    expect(frame).toContain('agentic workflows, on your repo');
    expect(frame).toContain('ready');
    expect(doneCount).toBe(1);

    unmount();
  });

  it('skips immediately on any keypress, before the animation completes', async () => {
    let doneCount = 0;
    const { stdin, unmount } = mountSplash(() => {
      doneCount += 1;
    });

    stdin.push('x');
    await settle();
    expect(doneCount).toBe(1);

    // A second stray keypress (or the interval still firing before its
    // cleanup lands) must not call onDone a second time — the caller
    // unmounts and mounts the real UI on the first call only.
    stdin.push('y');
    await settle();
    expect(doneCount).toBe(1);

    unmount();
  });

  it('centers the block on the screen it owns, keeping the rows left-aligned to each other', async () => {
    const { stdout, unmount } = mountSplash(() => {});

    // Past the wordmark reveal, so the block is at its full height.
    await settle(4200);
    const lines = lastFrame(stdout).replace(/\n$/, '').split('\n');
    const filled = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim().length > 0);
    const first = filled[0]!.i;
    const last = filled.at(-1)!.i;

    // Vertical: the blank rows above match what an exact centering of a block
    // this tall would leave. (The matching rows below are there too, but Ink
    // drops the frame's trailing blank line, so they are not all emitted.)
    expect(first).toBe(Math.floor((ROWS - (last - first + 1)) / 2));

    // Horizontal: left gap matches right gap, to within the one column an odd
    // leftover cannot split evenly. Measured across the block rather than per
    // row, because the rows are centered *as a unit* — they keep the shared
    // left edge that puts the caption under the chain's first glyph.
    const leftGap = Math.min(...filled.map(({ l }) => l.length - l.trimStart().length));
    const rightGap = COLUMNS - Math.max(...filled.map(({ l }) => l.trimEnd().length));
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);

    // The chain and the caption under it start at the same column — that is
    // the alignment the unit-centering exists to preserve.
    const indentOf = (l: string): number => l.length - l.trimStart().length;
    const chain = filled.find(({ l }) => l.includes('▶'))!.l;
    const caption = filled.find(({ l }) => l.includes('ready'))!.l;
    expect(indentOf(caption)).toBe(indentOf(chain));

    // And the wordmark starts there too, now that its FIGlet padding is gone —
    // its last line is flush left, so the logo squares up with the chain.
    const logo = filled.filter(({ l }) => l.includes('\\')).map(({ l }) => l);
    expect(Math.min(...logo.map(indentOf))).toBe(indentOf(chain));

    unmount();
  }, 10000);

  it('skips outright below the minimum terminal width, without rendering the diagram', async () => {
    let doneCount = 0;
    const { stdout, unmount } = mountSplash(
      () => {
        doneCount += 1;
      },
      { stdoutColumns: 30 },
    );

    await settle();
    expect(doneCount).toBe(1);
    expect(lastFrame(stdout)).not.toContain('▶');

    unmount();
  });

  it('skips outright with no TTY, so a piped or CI invocation is not delayed', async () => {
    let doneCount = 0;
    const { stdout, unmount } = mountSplash(
      () => {
        doneCount += 1;
      },
      { stdoutTTY: false },
    );

    await settle();
    expect(doneCount).toBe(1);
    expect(lastFrame(stdout)).not.toContain('▶');

    unmount();
  });
});

describe('Splash frame helpers', () => {
  it('reveals the wordmark one line per frame, capped at the line count', () => {
    expect(wordmarkLinesAt(0)).toBe(0);
    expect(wordmarkLinesAt(WORDMARK_START - 1)).toBe(0);
    expect(wordmarkLinesAt(WORDMARK_START)).toBe(1);
    expect(wordmarkLinesAt(WORDMARK_START + 1)).toBe(2);
    expect(wordmarkLinesAt(WORDMARK_START + WORDMARK_LINE_COUNT - 1)).toBe(WORDMARK_LINE_COUNT);
    expect(wordmarkLinesAt(AUTO_DONE_FRAME)).toBe(WORDMARK_LINE_COUNT);
  });

  it('tells the fail/retry/ready story with the right colors', () => {
    expect(captionAt(0)).toBeNull();
    // D fails at frame 8 (D_END) and holds its red glyph until the retry kicks off.
    expect(captionAt(9)).toEqual({ text: 'failed', color: 'red' });
    // Retry window runs through D2_END (frame 16).
    expect(captionAt(12)).toEqual({ text: 'retrying…', color: 'yellow' });
    // Once the whole wordmark is up, the splash settles on a green "ready".
    expect(captionAt(AUTO_DONE_FRAME)).toEqual({ text: 'ready', color: 'green' });
  });

  it('leaves AUTO_DONE_FRAME two hold frames past the full reveal', () => {
    expect(AUTO_DONE_FRAME).toBe(WORDMARK_START + WORDMARK_LINE_COUNT + 2);
  });
});
