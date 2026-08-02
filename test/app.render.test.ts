import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import { MOVE_HANDLE, RESIZE_GRIP } from '../src/ui/panel.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

const NO_MODEL_CONTEXT: ModelContext = {
  providerId: undefined,
  providerDefaultModel: undefined,
  workflowSettingsModel: undefined,
};

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

// 120ms rather than a hair-trigger value: under the full suite's load (many
// concurrent Ink renders across files), a too-tight wait here reads a frame
// from before React has processed the update and is genuinely flaky, not a
// real assertion about timing.
const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      modelContext: NO_MODEL_CONTEXT,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    // interactive: the fake stdout above *is* the TTY under test. Without
    // this, Ink's CI detection drops to non-interactive mode and writes only
    // the final frame at unmount, so these tests see nothing on CI.
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { ports, stdout, stdin, unmount: () => instance.unmount() };
}

const DETAIL_WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);

describe('App node-detail panel rendering', () => {
  it('wraps long agent output instead of cutting it off at the panel edge', async () => {
    const store = storeFor(DETAIL_WF, makeTempGitRepo());
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const instance = render(
      React.createElement(App, {
        workflow: DETAIL_WF,
        store,
        ports: new UiInteractionPorts(),
        modelContext: NO_MODEL_CONTEXT,
        onExit: () => {},
        onInterrupt: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
    );
    try {
      // One long line, no newlines: it cannot fit on a single terminal row.
      const sentence = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
      store.appendLiveOutput('impl', sentence + '\n');
      stdin.write('\r'); // expand the detail panel for the focused node
      await settle();

      const lines = lastFrameLines(stdout);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(COLUMNS);
      // The tail of the sentence survives on a following row rather than
      // being truncated away with the rest of the line.
      const body = lines.join('\n');
      expect(body).toContain('word0 ');
      expect(body).toContain('word23');
    } finally {
      instance.unmount();
    }
  });
});

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

  it('renders the agent markdown, and echoes the user markers verbatim', async () => {
    const { ports, stdout, stdin, unmount } = mountDiscussApp();
    try {
      ports.discuss.begin('talk', 'colors', []);
      ports.discuss.postAssistant(
        'talk',
        '## Options\n\n- **blue**, the `--blue` flag\n- red\n\n```sh\nrun --blue\n```',
      );
      const next = ports.discuss.nextUserMessage('talk');
      await settle();
      stdin.write('use **blue**');
      await settle();
      stdin.write('\r');
      await expect(next).resolves.toBe('use **blue**');
      await settle();

      const frame = lastFrameLines(stdout).join('\n');
      // Markup is applied, not printed: no hashes, asterisks or backticks left.
      expect(frame).toContain('agent: Options');
      expect(frame).toContain('• blue, the --blue flag');
      expect(frame).toContain('• red');
      expect(frame).toContain('run --blue');
      expect(frame).not.toContain('## Options');
      expect(frame).not.toContain('**blue**, ');
      expect(frame).not.toContain('```');
      // The user's own text is never reinterpreted — they typed those stars.
      expect(frame).toContain('you: use **blue**');
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
