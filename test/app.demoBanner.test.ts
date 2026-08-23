import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, DEMO_BANNER_TEXT, type ModelContext } from '../src/ui/App.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

const NO_MODEL_CONTEXT: ModelContext = {
  providerId: undefined,
  providerDefaultModel: undefined,
  workflowSettingsModel: undefined,
};

const WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);

const ROWS = 30;
const COLUMNS = 100;

interface FakeStdout extends NodeJS.WriteStream {
  frames: string[];
}

function fakeStdout(rows = ROWS): FakeStdout {
  const frames: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as unknown as FakeStdout;
  Object.assign(out, { columns: COLUMNS, rows, isTTY: true, frames });
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

function mountApp(opts: { demo?: boolean; rows?: number } = {}) {
  const store = storeFor(WF, makeTempGitRepo());
  const ports = new UiInteractionPorts();
  const stdout = fakeStdout(opts.rows);
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(App, {
      workflow: WF,
      store,
      ports,
      modelContext: NO_MODEL_CONTEXT,
      onExit: () => {},
      onInterrupt: () => {},
      ...(opts.demo !== undefined ? { demo: opts.demo } : {}),
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { stdout, unmount: () => instance.unmount() };
}

describe('the demo disclosure banner', () => {
  it('is present in a demo run', async () => {
    const { stdout, unmount } = mountApp({ demo: true });
    await settle();
    const lines = lastFrameLines(stdout);
    expect(lines.some((l) => l.includes(DEMO_BANNER_TEXT))).toBe(true);
    unmount();
  });

  it('is absent from an ordinary run', async () => {
    const { stdout, unmount } = mountApp({ demo: false });
    await settle();
    const lines = lastFrameLines(stdout);
    expect(lines.some((l) => l.includes(DEMO_BANNER_TEXT))).toBe(false);
    unmount();
  });

  it('is absent when demo is simply omitted', async () => {
    const { stdout, unmount } = mountApp();
    await settle();
    const lines = lastFrameLines(stdout);
    expect(lines.some((l) => l.includes(DEMO_BANNER_TEXT))).toBe(false);
    unmount();
  });

  it('survives a resize — still present after the terminal changes size', async () => {
    const { stdout, unmount } = mountApp({ demo: true, rows: ROWS });
    await settle();
    Object.assign(stdout, { rows: ROWS + 10 });
    stdout.emit('resize');
    await settle();
    const lines = lastFrameLines(stdout);
    expect(lines.some((l) => l.includes(DEMO_BANNER_TEXT))).toBe(true);
    unmount();
  });
});
