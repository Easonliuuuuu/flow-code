import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { STATUS_GLYPHS } from '../src/ui/canvas.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import type { RunStateStore } from '../src/runstate/store.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * End-to-end coverage of the approval-gate panel's optional AI critique —
 * mirrors app.render.test.ts's discuss-panel tests: mount the real App
 * against a fake TTY, drive `ports.approval.request` directly (the same way
 * the executor would), and read the rendered frame.
 */

const NO_MODEL_CONTEXT: ModelContext = {
  providerId: undefined,
  providerDefaultModel: undefined,
  workflowSettingsModel: undefined,
};

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

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastFrameLines(stdout: FakeStdout): string[] {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return (plain.filter((f) => f.trim().length > 0).at(-1) ?? '').split('\n');
}

const WF = workflowFromYaml(`
nodes:
  - id: gate
    type: approval-gate
`);

function mountGateApp(): {
  ports: UiInteractionPorts;
  store: RunStateStore;
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
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { ports, store, stdout, stdin, unmount: () => instance.unmount() };
}

describe('Approval-gate panel rendering', () => {
  it('shows the AI critique above the diff, clearly labelled and distinct from it', async () => {
    const { ports, stdout, unmount } = mountGateApp();
    try {
      void ports.approval.request({
        nodeId: 'gate',
        title: 'Review the change',
        diffs: [{ diff: '+added line\n-removed line' }],
        upstreamSummaries: [],
        agentSummary: 'Looks reasonable overall; the new branch has no test coverage.',
      });
      await settle();

      const frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('AI critique');
      expect(frame).toContain('Looks reasonable overall; the new branch has no test coverage.');
      expect(frame).toContain('added line');
      expect(frame).toContain('removed line');
    } finally {
      unmount();
    }
  });

  it('omits the critique block entirely when the gate has no agent step configured', async () => {
    const { ports, stdout, unmount } = mountGateApp();
    try {
      void ports.approval.request({
        nodeId: 'gate',
        title: 'Review the change',
        diffs: [{ diff: '+added line' }],
        upstreamSummaries: [],
      });
      await settle();

      const frame = lastFrameLines(stdout).join('\n');
      expect(frame).not.toContain('AI critique');
      expect(frame).toContain('added line');
    } finally {
      unmount();
    }
  });

  it('replays the diff on a decided gate when its node panel is opened', async () => {
    const { store, stdout, stdin, unmount } = mountGateApp();
    try {
      // Simulate the executor's post-decision write instead of driving a real
      // decision through the port, since the point here is what's persisted
      // and re-shown, not the live approve/reject flow (covered above).
      store.setOutput('gate', {
        decision: 'approved',
        decidedAt: new Date().toISOString(),
        diffs: [{ diff: '+kept line\n-dropped line' }],
      });
      store.setStatus('gate', 'done', 'approved');
      stdin.write('\r'); // enter: expand the focused (only) node's panel
      await settle();

      const frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('kept line');
      expect(frame).toContain('dropped line');
      expect(frame).toContain('approved');
    } finally {
      unmount();
    }
  });

  it('does not draw a rejected gate as a success, though it reaches `done`', async () => {
    const { store, stdout, unmount } = mountGateApp();
    try {
      store.setOutput('gate', {
        decision: 'rejected',
        decidedAt: new Date().toISOString(),
        diffs: [{ diff: '+rejected line' }],
      });
      store.setStatus('gate', 'done', 'rejected by user');
      await settle();

      // The card takes the failed glyph off the decision, not the status —
      // the filled dot a `done` node would otherwise get reads as "went fine".
      // Scoped to the node's own card: the header tally still counts it under
      // `done`, which is what its status genuinely is.
      const card = lastFrameLines(stdout).find((l) => l.includes('gate') && !l.includes('run '));
      expect(card).toBeDefined();
      expect(card).toContain(STATUS_GLYPHS.error);
      expect(card).not.toContain(STATUS_GLYPHS.done);
    } finally {
      unmount();
    }
  });
});

describe('Approval-gate focus scoping', () => {
  // Needs a second node to tab to — the single-node WF above can't exercise this.
  const WF2 = workflowFromYaml(`
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
      - id: gate
        type: approval-gate
    edges:
      - { from: impl, to: gate }
  `);

  function mountTwoNodeApp(): {
    ports: UiInteractionPorts;
    store: RunStateStore;
    stdout: FakeStdout;
    stdin: NodeJS.ReadStream;
    unmount: () => void;
  } {
    const store = storeFor(WF2, makeTempGitRepo());
    const ports = new UiInteractionPorts();
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const instance = render(
      React.createElement(App, {
        workflow: WF2,
        store,
        ports,
        modelContext: NO_MODEL_CONTEXT,
        onExit: () => {},
        onInterrupt: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
    );
    return { ports, store, stdout, stdin, unmount: () => instance.unmount() };
  }

  it('lets you tab away to inspect another node while a decision is pending, and re-shows the prompt when you tab back', async () => {
    const { ports, stdout, stdin, unmount } = mountTwoNodeApp();
    try {
      void ports.approval.request({
        nodeId: 'gate',
        title: 'Review the change',
        diffs: [{ diff: '+added line' }],
        upstreamSummaries: [],
      });
      await settle();
      let frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('Approval — Review the change');

      // Tab away to `impl`: the approval prompt must not stay pinned open —
      // this is the bug being fixed (it used to render regardless of focus).
      stdin.write('\t');
      await settle();
      frame = lastFrameLines(stdout).join('\n');
      expect(frame).not.toContain('Approval — Review the change');

      // Enter opens impl's own detail panel, not the gate's.
      stdin.write('\r');
      await settle();
      frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('impl (Implement)');
      stdin.write('\r'); // close it back up before tabbing again
      await settle();

      // Tab back onto the gate: the approval prompt returns on its own.
      stdin.write('\t');
      await settle();
      frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('Approval — Review the change');
    } finally {
      unmount();
    }
  });

  it('does not let a/r resolve the gate while focus has moved elsewhere', async () => {
    const { ports, stdin, unmount } = mountTwoNodeApp();
    try {
      const decision = ports.approval.request({
        nodeId: 'gate',
        title: 'Review the change',
        diffs: [{ diff: '+added line' }],
        upstreamSummaries: [],
      });
      let resolved = false;
      void decision.then(() => {
        resolved = true;
      });
      await settle();

      stdin.write('\t'); // tab away from the gate onto impl
      await settle();
      stdin.write('a');
      await settle();

      expect(resolved).toBe(false);
    } finally {
      unmount();
    }
  });
});
