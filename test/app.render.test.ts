import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/App.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import { MOVE_HANDLE, RESIZE_GRIP } from '../src/ui/panel.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * End-to-end render tests: mount the real App against a fake TTY and read the
 * frames it writes. Covers what the pure geometry tests can't — that panel
 * content actually reaches the screen and lands where the mouse expects it.
 */

const WF = workflowFromYaml(`
nodes:
  - id: talk
    type: discuss
    config: { topic: colors }
`);

const ROWS = 30;
const COLUMNS = 100;

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
  Object.assign(out, { columns: COLUMNS, rows: ROWS, isTTY: true, frames });
  return out;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stream, { isTTY: true, setRawMode: () => stream, ref: () => {}, unref: () => {} });
  return stream;
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Last frame with visible content, stripped of styling escapes, as lines. */
function lastFrameLines(stdout: FakeStdout): string[] {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return (plain.filter((f) => f.trim().length > 0).at(-1) ?? '').split('\n');
}

function mountDiscussApp(): {
  ports: UiInteractionPorts;
  stdout: FakeStdout;
  stdin: NodeJS.ReadStream;
  unmount: () => void;
} {
  const store = storeFor(WF, makeTempGitRepo());
  const ports = new UiInteractionPorts();
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(App, {
      workflow: WF,
      store,
      ports,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  return { ports, stdout, stdin, unmount: () => instance.unmount() };
}

describe('App discuss panel rendering', () => {
  it('shows the message the user submits, and the reply that follows', async () => {
    const { ports, stdout, stdin, unmount } = mountDiscussApp();
    try {
      ports.discuss.begin('talk', 'colors', []);
      ports.discuss.postAssistant('talk', 'what shade did you have in mind?');
      const next = ports.discuss.nextUserMessage('talk');
      await settle();

      stdin.write('make it blue');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('> make it blue');

      stdin.write('\r');
      await expect(next).resolves.toBe('make it blue');
      ports.discuss.postAssistant('talk', 'blue it is');
      await settle();

      const frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('you: make it blue');
      expect(frame).toContain('agent: blue it is');
    } finally {
      unmount();
    }
  });

  it('resizes when the bottom-right grip is dragged', async () => {
    const { ports, stdout, stdin, unmount } = mountDiscussApp();
    // SGR (1006) mouse reports, 1-based coordinates.
    const press = (x: number, y: number) => stdin.write(`\x1b[<0;${x + 1};${y + 1}M`);
    const drag = (x: number, y: number) => stdin.write(`\x1b[<32;${x + 1};${y + 1}M`);
    const release = (x: number, y: number) => stdin.write(`\x1b[<0;${x + 1};${y + 1}m`);
    try {
      ports.discuss.begin('talk', 'colors', []);
      await settle();
      const before = lastFrameLines(stdout);
      const top = before.findIndex((l) => l.startsWith('╭') && l.length === COLUMNS);
      const grip = { x: COLUMNS - 3, y: ROWS - 2 };

      press(grip.x, grip.y);
      drag(grip.x, grip.y - 4);
      release(grip.x, grip.y - 4);
      await settle();

      const after = lastFrameLines(stdout);
      // Same top edge, bottom edge pulled up by the four rows dragged.
      expect(after[top]!.startsWith('╭')).toBe(true);
      expect(after[ROWS - 5]!.startsWith('╰')).toBe(true);
      expect(after[0]).toContain('ctrl+p: dock panel'); // header advertises the way back
    } finally {
      unmount();
    }
  });

  it('draws the docked panel exactly where the mouse hit-tests it', async () => {
    const { ports, stdout, unmount } = mountDiscussApp();
    try {
      ports.discuss.begin('talk', 'colors', []);
      await settle();
      const lines = lastFrameLines(stdout);
      // dockedLayout puts the panel flush against the bottom row, full width;
      // the move handle sits on its title row and the grip in its last corner.
      const top = lines.findIndex((l) => l.startsWith('╭') && l.length === COLUMNS);
      expect(lines.length).toBe(ROWS);
      expect(lines[top + 1]).toContain(MOVE_HANDLE);
      expect(lines[ROWS - 2]).toContain(RESIZE_GRIP);
      expect(lines[ROWS - 1]!.startsWith('╰')).toBe(true);
      expect(lines[ROWS - 1]!.length).toBe(COLUMNS);
    } finally {
      unmount();
    }
  });
});
