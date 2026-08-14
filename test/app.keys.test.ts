import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import type { RunStateStore } from '../src/runstate/store.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import type { Workflow } from '../src/workflow/load.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * The keys that had no coverage because nothing implemented them: the key map
 * itself (`?`), escape closing the node-detail panel, `m`/`s` reaching across
 * from the settings editor, and ctrl+w/ctrl+u in a text field. Driven through
 * a real Ink render, since all of it lives inside App's own useInput handler.
 */

const WF = workflowFromYaml(`
settings:
  model: sonnet

nodes:
  - id: talk
    type: discuss
    config: { topic: colors }
  - id: impl
    type: implement
    config: { instructions: x }
  - id: t
    type: test
    config: { commands: ["npm test"] }
edges:
  - { from: talk, to: impl }
  - { from: impl, to: t }
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

// 120ms, matching app.render.test.ts: under the full suite's load (many
// concurrent Ink renders) a tighter wait reads a frame from before React has
// processed the keypress, which is flakiness rather than a real assertion.
const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastFrame(stdout: FakeStdout): string {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return plain.filter((f) => f.trim().length > 0).at(-1) ?? '';
}

function mountApp(
  opts: { workflow?: Workflow; store?: RunStateStore; watch?: boolean } = {},
): {
  ports: UiInteractionPorts;
  store: RunStateStore;
  stdout: FakeStdout;
  stdin: NodeJS.ReadStream;
  unmount: () => void;
} {
  const workflow = opts.workflow ?? WF;
  const store = opts.store ?? storeFor(workflow, makeTempGitRepo());
  const modelContext: ModelContext = {
    providerId: 'claude',
    providerDefaultModel: undefined,
    workflowSettingsModel: 'sonnet',
  };
  const ports = new UiInteractionPorts();
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(App, {
      workflow,
      store,
      ports,
      modelContext,
      watch: opts.watch ?? false,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { ports, store, stdout, stdin, unmount: () => instance.unmount() };
}

describe('the key map (?)', () => {
  it('opens on ?, lists keys the hint line has no room for, and closes on ?', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      expect(lastFrame(stdout)).toContain('?: keys');

      stdin.write('?');
      await settle();
      const open = lastFrame(stdout);
      expect(open).toContain('Keys');
      // The keys the one-row hint line drops first.
      expect(open).toContain('ctrl+p');
      // Longer than a 30-row terminal, so the rest is a scroll away — and the
      // title says how much of it is, rather than letting the map end without
      // saying it had.
      expect(open).toMatch(/below\)/);
      stdin.write('\x1b[6~'); // PgDn
      await settle();
      expect(lastFrame(stdout)).toContain('Mouse');

      stdin.write('?');
      await settle();
      expect(lastFrame(stdout)).not.toContain('Mouse');
      expect(lastFrame(stdout)).toContain('?: keys');
    } finally {
      unmount();
    }
  });

  it('closes on escape, and swallows the canvas keys while it is up', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write('?');
      await settle();
      // `o` would flip the canvas to overview if the map didn't own the
      // keyboard — a mode change behind a panel covering the canvas.
      stdin.write('o');
      await settle();
      expect(lastFrame(stdout)).not.toContain(' · overview');

      stdin.write('\x1b');
      await settle();
      expect(lastFrame(stdout)).not.toContain('Mouse');
    } finally {
      unmount();
    }
  });

  it('says the per-node keys are off while watching, because watch refuses them', async () => {
    const { stdout, stdin, unmount } = mountApp({ watch: true });
    try {
      await settle();
      stdin.write('?');
      await settle();
      expect(lastFrame(stdout)).toContain('watching');
    } finally {
      unmount();
    }
  });
});

describe('escape closes the node-detail panel', () => {
  it('backs out of the panel enter opened, like every other panel', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write('\t'); // focus impl, whose detail panel has config to show
      await settle();
      stdin.write('\r');
      await settle();
      expect(lastFrame(stdout)).toContain('instructions: x');

      stdin.write('\x1b');
      await settle();
      expect(lastFrame(stdout)).not.toContain('instructions: x');
      // The hint line is back, i.e. the panel really closed rather than the
      // frame merely losing that one line.
      expect(lastFrame(stdout)).toContain('?: keys');
    } finally {
      unmount();
    }
  });
});

describe('the settings editor reaches the other two per-node panels', () => {
  it('m opens the model picker for the same node, as its footer says it does', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write('\t'); // impl
      await settle();
      stdin.write('e');
      await settle();
      expect(lastFrame(stdout)).toContain('Settings — impl');

      stdin.write('m');
      await settle();
      const frame = lastFrame(stdout);
      expect(frame).toContain('Model — impl');
      expect(frame).not.toContain('Settings — impl');
    } finally {
      unmount();
    }
  });

  it('leaves the settings panel up when the picker declines, so the reason has context', async () => {
    // A Test node runs commands, not a model, so `m` explains itself instead
    // of opening — and must not close the panel it was pressed in.
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write('\t'); // talk -> impl
      await settle();
      stdin.write('\t'); // impl -> t
      await settle();
      stdin.write('e');
      await settle();
      expect(lastFrame(stdout)).toContain('Settings — t');

      stdin.write('m');
      await settle();
      const frame = lastFrame(stdout);
      expect(frame).toContain('Settings — t');
      expect(frame).toContain('no model to choose');
    } finally {
      unmount();
    }
  });
});

describe('shift+tab in the approval gate', () => {
  it('steps focus back, rather than a full lap forward around the graph', async () => {
    const { ports, stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      void ports.approval.request({
        nodeId: 'impl',
        title: 'Review the change',
        diffs: [{ diff: '+a line' }],
        upstreamSummaries: [],
      });
      await settle();
      // The request focuses its own node, so there is somewhere to step back to.
      expect(lastFrame(stdout)).toContain('focused: impl');

      // Ink reports shift+tab as `tab` with `shift` set; reading the bare
      // `tab` sent it forwards, so backing up one node to re-read it meant
      // tabbing all the way round the graph instead.
      stdin.write('\x1b[Z');
      await settle();
      expect(lastFrame(stdout)).toContain('focused: talk');

      stdin.write('\t');
      await settle();
      expect(lastFrame(stdout)).toContain('focused: impl');
    } finally {
      unmount();
    }
  });
});

describe('line editing in a text field', () => {
  it('ctrl+w drops the last word and ctrl+u the whole line', async () => {
    const { ports, stdout, stdin, unmount } = mountApp();
    try {
      ports.discuss.begin('talk', 'colors', []);
      ports.discuss.postAssistant('talk', 'what shade?');
      void ports.discuss.nextUserMessage('talk');
      await settle();

      stdin.write('make it blue');
      await settle();
      expect(lastFrame(stdout)).toContain('> make it blue');

      stdin.write('\x17'); // ctrl+w
      await settle();
      expect(lastFrame(stdout)).toContain('> make it');
      expect(lastFrame(stdout)).not.toContain('blue');

      stdin.write('\x15'); // ctrl+u
      await settle();
      expect(lastFrame(stdout)).not.toContain('make it');
    } finally {
      unmount();
    }
  });
});
