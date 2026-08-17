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

const CANVAS_WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: test
    config: { commands: ["true"] }
  - id: rev
    type: review
edges:
  - { from: impl, to: check }
  - { from: impl, to: rev }
`);

describe('App view-mode toggle', () => {
  it('o switches to overview (denser, borderless cards) and back to focus', async () => {
    const store = storeFor(CANVAS_WF, makeTempGitRepo());
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const instance = render(
      React.createElement(App, {
        workflow: CANVAS_WF,
        store,
        ports: new UiInteractionPorts(),
        modelContext: NO_MODEL_CONTEXT,
        onExit: () => {},
        onInterrupt: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
    );
    try {
      const focusFrame = lastFrameLines(stdout).join('\n');
      expect(focusFrame).not.toContain(' · overview');
      expect(focusFrame).toMatch(/[╭╰┏┗]/);

      stdin.write('o');
      await settle();
      const overviewFrame = lastFrameLines(stdout).join('\n');
      // A node further down the graph is still visible, and the header says
      // which mode is active now.
      expect(overviewFrame).toContain('rev');
      expect(overviewFrame).toContain(' · overview');
      // Denser: no card borders anywhere in the frame.
      expect(overviewFrame).not.toMatch(/[╭╰┏┗]/);

      stdin.write('o');
      await settle();
      const backFrame = lastFrameLines(stdout).join('\n');
      expect(backFrame).not.toContain(' · overview');
      expect(backFrame).toMatch(/[╭╰┏┗]/);
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

  it('says how to end the discussion right under the caret, draft or no draft', async () => {
    const { ports, stdout, stdin, unmount } = mountDiscussApp();
    try {
      ports.discuss.begin('talk', 'colors', []);
      ports.discuss.postAssistant('talk', 'what shade did you have in mind?');
      const next = ports.discuss.nextUserMessage('talk');
      await settle();

      // Idle at the prompt: both ways out are spelled out, not just in the footer.
      const idle = lastFrameLines(stdout).join('\n');
      expect(idle).toContain('esc or /done: finish the discussion');

      // Mid-draft escape clears the text rather than ending the conversation,
      // so the hint has to stop advertising it as the way out.
      stdin.write('make it blue');
      await settle();
      const drafting = lastFrameLines(stdout).join('\n');
      expect(drafting).toContain('esc: clear draft');
      expect(drafting).not.toContain('esc or /done');

      // …and it really does only clear the draft.
      stdin.write('\x1b');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('esc or /done: finish the discussion');

      // A second escape, with the box empty, ends it.
      stdin.write('\x1b');
      await expect(next).resolves.toBeNull();
    } finally {
      unmount();
    }
  });

  it('keeps the newest message, the options and the hint on screen together', async () => {
    const { ports, stdout, unmount } = mountDiscussApp();
    try {
      ports.discuss.begin('talk', 'colors', []);
      for (let i = 0; i < 40; i++) ports.discuss.postAssistant('talk', `filler line ${i}`);
      ports.discuss.postAssistant('talk', 'so: which shade?', ['blue', 'red', 'green']);
      void ports.discuss.nextUserMessage('talk');
      await settle();

      const lines = lastFrameLines(stdout);
      const frame = lines.join('\n');
      expect(lines.length).toBeLessThanOrEqual(ROWS);
      // The transcript window shrinks to fit the options and the hint, rather
      // than pushing the tail of the conversation out of the panel.
      expect(frame).toContain('agent: so: which shade?');
      expect(frame).toContain('❯ blue');
      expect(frame).toContain('green');
      expect(frame).toContain('esc or /done: finish the discussion');
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

  it('tab steps away to another node without losing the draft, and tabbing back resumes it', async () => {
    const wf = workflowFromYaml(`
      nodes:
        - id: talk
          type: discuss
          config: { topic: colors }
        - id: impl
          type: implement
          config: { instructions: x }
      edges:
        - { from: talk, to: impl }
    `);
    const store = storeFor(wf, makeTempGitRepo());
    const ports = new UiInteractionPorts();
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const instance = render(
      React.createElement(App, {
        workflow: wf,
        store,
        ports,
        modelContext: NO_MODEL_CONTEXT,
        onExit: () => {},
        onInterrupt: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
    );
    try {
      ports.discuss.begin('talk', 'colors', []);
      ports.discuss.postAssistant('talk', 'what shade did you have in mind?');
      ports.discuss.nextUserMessage('talk');
      await settle();
      stdin.write('half-typed');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('> half-typed');

      // Tab away: the discuss transcript is replaced by the plain canvas hint
      // (impl isn't expanded), not left showing the conversation underneath.
      stdin.write('\t');
      await settle();
      let frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('focused:');
      expect(frame).not.toContain('half-typed');
      expect(frame).not.toContain('Discussion — talk');

      // Enter on the newly-focused node opens *its* detail panel, not discuss.
      stdin.write('\r');
      await settle();
      frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('impl (Implement)');
      expect(frame).not.toContain('Discussion — talk');
      stdin.write('\r'); // close it back up before tabbing again
      await settle();

      // Tab back onto the discuss node: conversation and draft both return.
      stdin.write('\t');
      await settle();
      frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('Discussion — talk');
      expect(frame).toContain('> half-typed');
    } finally {
      instance.unmount();
    }
  });
});

describe('App frame height', () => {
  /**
   * HEADER_ROWS + canvasHeight + FOOTER_ROWS is budgeted to exactly `rows`.
   * If either single-row line wraps instead of truncating, the frame comes
   * out one row taller than the terminal, the terminal scrolls to make room,
   * and the header ends up drawn over the top of the canvas. Ink will happily
   * emit that frame, so the guard has to live here.
   */
  it('never renders more rows than the terminal has, panel open or closed', async () => {
    const { stdout, stdin, unmount } = mountDiscussApp();
    try {
      await settle();
      expect(lastFrameLines(stdout).length).toBeLessThanOrEqual(ROWS);

      stdin.write('\r'); // enter: open the detail panel
      await settle();
      expect(lastFrameLines(stdout).length).toBeLessThanOrEqual(ROWS);

      stdin.write('\r'); // enter again: back to the hint line
      await settle();
      expect(lastFrameLines(stdout).length).toBeLessThanOrEqual(ROWS);
    } finally {
      unmount();
    }
  });

  it('keeps the hint line to one row, truncating rather than wrapping', async () => {
    const { stdout, stdin, unmount } = mountDiscussApp();
    try {
      await settle();
      // At 100 columns the full key list does not fit, which is fine — the
      // point is that the overflow is cut off rather than flowed onto a second
      // row that the frame has no space for. `?` and `q` lead, in that order:
      // between them they are the two keys you cannot discover any other way,
      // so they are the last to go.
      const lines = lastFrameLines(stdout);
      expect(lines.at(-1)).toContain('?: keys');
      expect(lines.at(-1)).toContain('q: quit');
      expect(lines.at(-2)).not.toContain('tab: focus');

      stdin.write('o'); // mini zoom relabels the hint — still one row
      await settle();
      const after = lastFrameLines(stdout);
      expect(after.length).toBeLessThanOrEqual(ROWS);
      expect(after.at(-2)).not.toContain('tab: focus');
    } finally {
      unmount();
    }
  });

  it('reports the focused node in the header, where a docked panel cannot hide it', async () => {
    const { stdout, stdin, unmount } = mountDiscussApp();
    try {
      await settle();
      expect(lastFrameLines(stdout)[0]).toContain('focused: talk');

      // Still there with the detail panel open, which replaces the hint line.
      stdin.write('\r');
      await settle();
      const frame = lastFrameLines(stdout);
      expect(frame[0]).toContain('focused: talk');
      expect(frame.length).toBeLessThanOrEqual(ROWS);
    } finally {
      unmount();
    }
  });

  it('attributes a fan-out node\'s activity rows without overflowing a narrow panel', async () => {
    const store = storeFor(DETAIL_WF, makeTempGitRepo());
    // 80 columns: the classic minimum, and the width where an extra column is
    // most likely to push a row past the panel's edge.
    const stdout = fakeStdout();
    Object.assign(stdout, { columns: 80 });
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
      for (const [instanceId, summary] of [
        ['alt-1', 'npm run build'],
        ['alt-2', 'npm test'],
      ] as const) {
        store.appendActivity({
          ts: new Date().toISOString(),
          nodeId: 'impl',
          instanceId,
          tool: 'Bash',
          summary,
          decision: 'allowed',
        });
      }
      stdin.write('\r');
      await settle();

      const lines = lastFrameLines(stdout);
      const body = lines.join('\n');
      expect(body).toContain('alt-1');
      expect(body).toContain('alt-2');
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
      expect(lines.length).toBeLessThanOrEqual(ROWS);
    } finally {
      instance.unmount();
    }
  });

  it('holds the status counts in lifecycle order as the run moves through them', async () => {
    const store = storeFor(CANVAS_WF, makeTempGitRepo());
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const instance = render(
      React.createElement(App, {
        workflow: CANVAS_WF,
        store,
        ports: new UiInteractionPorts(),
        modelContext: NO_MODEL_CONTEXT,
        onExit: () => {},
        onInterrupt: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
    );
    try {
      await settle();
      expect(lastFrameLines(stdout)[0]).toContain('○ 3');

      // `impl` reaches `running` before `rev` reaches `done`, so reading the
      // counts off the record's own key order put `◐` ahead of `○` — the
      // idle count jumping rightward the moment anything started, and every
      // segment after it shuffling again on each new status.
      store.setStatus('impl', 'running');
      store.setStatus('rev', 'done');
      await settle();
      expect(lastFrameLines(stdout)[0]).toContain('○ 1  ◐ 1  ● 1');
    } finally {
      instance.unmount();
    }
  });

  it('shows plan rate-limit utilization once the provider reports it', async () => {
    const store = storeFor(WF, makeTempGitRepo());
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const instance = render(
      React.createElement(App, {
        workflow: WF,
        store,
        ports: new UiInteractionPorts(),
        modelContext: NO_MODEL_CONTEXT,
        onExit: () => {},
        onInterrupt: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
    );
    try {
      await settle();
      // Nothing before a provider reports: a run against an API key never
      // will, and the header must not imply a fresh window.
      expect(lastFrameLines(stdout)[0]).not.toContain('5h');

      store.recordRateLimit('five_hour', { utilization: 34, status: 'allowed' });
      store.recordRateLimit('seven_day', { utilization: 61, status: 'allowed' });
      await settle();

      const frame = lastFrameLines(stdout);
      expect(frame[0]).toContain('5h 34%');
      expect(frame[0]).toContain('7d 61%');
      // HEADER_ROWS budgets exactly one row; a second wraps the frame past
      // `rows` and the terminal scrolls the canvas away.
      expect(frame[0]!.length).toBeLessThanOrEqual(COLUMNS);
      expect(frame.length).toBeLessThanOrEqual(ROWS);
    } finally {
      instance.unmount();
    }
  });
});
