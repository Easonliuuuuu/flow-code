import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { RunStateStore } from '../src/runstate/store.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import type { Workflow } from '../src/workflow/load.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * The panel a Test node opens when it reaches execution with nothing
 * configured to run. Driven through a real Ink render, like the other panel
 * tests — the state machine lives in App's own useInput handler.
 */

const WORKFLOW_YAML = `nodes:
  - id: t
    type: test
    config:
      commands: ["echo placeholder"]
`;

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
  Object.assign(out, { columns: 100, rows: 30, isTTY: true, frames });
  return out;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stream, { isTTY: true, setRawMode: () => stream, ref: () => {}, unref: () => {} });
  return stream;
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastFrame(stdout: FakeStdout): string {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return plain.filter((f) => f.trim().length > 0).at(-1) ?? '';
}

/**
 * Waits for `text` to actually reach the screen, instead of sleeping a fixed
 * interval and hoping. Needed wherever a keypress kicks off async work:
 * discovery is two hops deep (the agent call, then React's re-render), so a
 * fixed `settle` is a race that stays hidden until the full suite's load
 * slows the render down.
 */
async function settleUntil(stdout: FakeStdout, text: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = lastFrame(stdout);
    if (frame.includes(text)) return frame;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)} to reach the screen`);
}

function mount(
  workflow: Workflow,
  store: RunStateStore,
  ports: UiInteractionPorts,
): { stdout: FakeStdout; stdin: NodeJS.ReadStream; unmount: () => void } {
  const modelContext: ModelContext = {
    providerId: 'claude',
    providerDefaultModel: undefined,
    workflowSettingsModel: undefined,
  };
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(App, {
      workflow,
      store,
      ports,
      modelContext,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { stdout, stdin, unmount: () => instance.unmount() };
}

interface SetupOpts {
  detected?: string[];
  proposals?: Array<{ command: string; rationale: string }>;
  discoverError?: string;
  discover?: () => Promise<Array<{ command: string; rationale: string }>>;
}

function setup(opts: SetupOpts = {}) {
  const workflow = workflowFromYaml(WORKFLOW_YAML);
  const ports = new UiInteractionPorts();
  const store = storeFor(workflow, makeTempGitRepo());
  const answer = ports.testCommands.request({
    nodeId: 't',
    detected: opts.detected ?? ['npm test'],
    proposals: opts.proposals ?? [],
    ...(opts.discoverError !== undefined ? { discoverError: opts.discoverError } : {}),
    discover: opts.discover ?? (async () => []),
  });
  return { workflow, ports, store, answer };
}

describe('test-command panel', () => {
  it('opens with everything found already checked, so confirming is one key', async () => {
    const { workflow, ports, store, answer } = setup();
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      const frame = await settleUntil(stdout, '[x] npm test');
      expect(frame).toContain('Test commands \u2014 t');

      stdin.write('\r');
      expect(await answer).toEqual(['npm test']);
    } finally {
      unmount();
    }
  });

  it('unchecks what does not belong, which is the work the prompt is for', async () => {
    const { workflow, ports, store, answer } = setup();
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      // Waiting for the seeded box specifically: space against an unseeded
      // panel checks it rather than clearing it, so this would not just be
      // slow to assert — it would assert the opposite thing.
      await settleUntil(stdout, '[x] npm test');
      stdin.write(' ');
      await settleUntil(stdout, '[ ] npm test');
      stdin.write('\r');
      // Confirming an empty selection reads as "run nothing here", the same
      // answer escape gives — a project with no suite yet is a real project.
      expect(await answer).toEqual([]);
    } finally {
      unmount();
    }
  });

  it('escape skips, answering null rather than an empty list', async () => {
    const { workflow, ports, store, answer } = setup();
    const { stdin, unmount } = mount(workflow, store, ports);
    try {
      await settle();
      stdin.write('\x1b');
      expect(await answer).toBeNull();
    } finally {
      unmount();
    }
  });

  it('confirming nothing checked is the same as skipping, from the executor\'s side', async () => {
    const { workflow, ports, store, answer } = setup({ detected: [] });
    const { stdin, unmount } = mount(workflow, store, ports);
    try {
      await settle();
      stdin.write('\r');
      expect(await answer).toEqual([]);
    } finally {
      unmount();
    }
  });

  it('adds a typed command, already checked', async () => {
    const { workflow, ports, store, answer } = setup();
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      await settleUntil(stdout, '[x] npm test');
      stdin.write('a');
      await settle();
      stdin.write('make check');
      await settleUntil(stdout, 'command: make check');
      stdin.write('\r');
      await settleUntil(stdout, '[x] make check');
      stdin.write('\r');
      // Added alongside what was found, not instead of it.
      expect(await answer).toEqual(['npm test', 'make check']);
    } finally {
      unmount();
    }
  });

  it('shows what the agent pass proposed, with its reasoning, already checked', async () => {
    const { workflow, ports, store, answer } = setup({
      proposals: [{ command: 'go test ./...', rationale: 'go.mod at the repo root' }],
    });
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      // Both passes ran before the panel opened, so both are on screen and
      // checked without a keypress — one seeding pass, so waiting for either
      // is waiting for both.
      const frame = await settleUntil(stdout, '[x] go test ./...');
      expect(frame).toContain('[x] npm test');
      expect(frame).toContain('go.mod at the repo root');

      stdin.write('\r');
      expect(await answer).toEqual(['npm test', 'go test ./...']);
    } finally {
      unmount();
    }
  });

  it('spends another session only when asked to look again', async () => {
    let discoverCalls = 0;
    const { workflow, ports, store, answer } = setup({
      discover: async () => {
        discoverCalls++;
        return [{ command: 'go test ./...', rationale: 'go.mod at the repo root' }];
      },
    });
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      await settleUntil(stdout, '[x] npm test');
      expect(discoverCalls).toBe(0);

      stdin.write('d');
      // The checked box, not just the text: what the second look turns up is
      // seeded by the same effect, so confirming on the bare text would race
      // it and answer without the new command.
      const frame = await settleUntil(stdout, '[x] go test ./...');
      expect(discoverCalls).toBe(1);
      expect(frame).toContain('go.mod at the repo root');

      // What the second look turned up is checked too, without disturbing
      // what was already on screen.
      stdin.write('\r');
      expect(await answer).toEqual(['npm test', 'go test ./...']);
    } finally {
      unmount();
    }
  });

  it('surfaces a discovery failure carried in with the request', async () => {
    // The executor's own agent pass failed before the panel opened. That is
    // not a failed node: the panel still opens on what the heuristics found.
    const { workflow, ports, store, answer } = setup({
      discoverError: 'no provider configured',
    });
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      const frame = await settleUntil(stdout, '[x] npm test');
      expect(frame).toContain('no provider configured');
      stdin.write('\r');
      expect(await answer).toEqual(['npm test']);
    } finally {
      unmount();
    }
  });

  it('surfaces a failure from a second look instead of losing the panel', async () => {
    const { workflow, ports, store, answer } = setup({
      discover: async () => {
        throw new Error('no provider configured');
      },
    });
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      await settleUntil(stdout, '[x] npm test');
      stdin.write('d');
      const frame = await settleUntil(stdout, 'no provider configured');
      expect(frame).toContain('no provider configured');
      // Still usable: the heuristic hit is right there, still checked.
      stdin.write('\r');
      expect(await answer).toEqual(['npm test']);
    } finally {
      unmount();
    }
  });
});
