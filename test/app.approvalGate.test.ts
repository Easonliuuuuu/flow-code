import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
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
  return { ports, stdout, stdin, unmount: () => instance.unmount() };
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
});
