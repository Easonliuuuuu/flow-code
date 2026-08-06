import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Splash } from '../src/ui/splash.js';

/**
 * The startup splash's frame math (`inputStateAt`/`convergenceStateAt`/
 * `AUTO_DONE_FRAME`) and its skip conditions had no automated coverage —
 * only the by-hand column arithmetic in the component itself. These tests
 * exercise both: that it actually plays through to the wordmark and calls
 * `onDone` once, and that every skip path (keypress, narrow terminal, no
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
  it('plays through the merge animation and calls onDone exactly once', async () => {
    let doneCount = 0;
    const { stdout, unmount } = mountSplash(() => {
      doneCount += 1;
    });

    // Mid-animation: the tributaries are still landing, the wordmark hasn't
    // shown yet, and nothing has finished.
    await settle(200);
    expect(lastFrame(stdout)).not.toContain('flow-code');
    expect(doneCount).toBe(0);

    // Past AUTO_DONE_FRAME (14 frames * 80ms = 1120ms): settled and done.
    await settle(1200);
    const frame = lastFrame(stdout);
    expect(frame).toContain('flow-code');
    expect(frame).toContain('agentic workflows, on your repo');
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
    expect(lastFrame(stdout)).not.toContain('╭');

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
    expect(lastFrame(stdout)).not.toContain('╭');

    unmount();
  });
});
