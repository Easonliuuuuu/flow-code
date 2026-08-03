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

function setup(discover?: () => Promise<Array<{ command: string; rationale: string }>>) {
  const workflow = workflowFromYaml(WORKFLOW_YAML);
  const ports = new UiInteractionPorts();
  const store = storeFor(workflow, makeTempGitRepo());
  const answer = ports.testCommands.request({
    nodeId: 't',
    detected: ['npm test'],
    discover: discover ?? (async () => []),
  });
  return { workflow, ports, store, answer };
}

describe('test-command panel', () => {
  it('lists what was detected and returns the checked commands', async () => {
    const { workflow, ports, store, answer } = setup();
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      await settle();
      expect(lastFrame(stdout)).toContain('Test commands \u2014 t');
      expect(lastFrame(stdout)).toContain('npm test');

      stdin.write(' ');
      await settle();
      stdin.write('\r');
      expect(await answer).toEqual(['npm test']);
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
    const { workflow, ports, store, answer } = setup();
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
      await settle();
      stdin.write('a');
      await settle();
      stdin.write('make check');
      await settle();
      expect(lastFrame(stdout)).toContain('command: make check');
      stdin.write('\r');
      await settle();
      expect(lastFrame(stdout)).toContain('make check');
      stdin.write('\r');
      expect(await answer).toEqual(['make check']);
    } finally {
      unmount();
    }
  });

  it('spends a session on discovery only when asked, and shows the reasoning', async () => {
    let discoverCalls = 0;
    const { workflow, ports, store, answer } = setup(async () => {
      discoverCalls++;
      return [{ command: 'go test ./...', rationale: 'go.mod at the repo root' }];
    });
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      await settle();
      expect(discoverCalls).toBe(0);

      stdin.write('d');
      await settle();
      expect(discoverCalls).toBe(1);
      expect(lastFrame(stdout)).toContain('go test ./...');
      expect(lastFrame(stdout)).toContain('go.mod at the repo root');

      stdin.write('j');
      await settle();
      stdin.write(' ');
      await settle();
      stdin.write('\r');
      expect(await answer).toEqual(['go test ./...']);
    } finally {
      unmount();
    }
  });

  it('surfaces a discovery failure instead of losing the panel', async () => {
    const { workflow, ports, store, answer } = setup(async () => {
      throw new Error('no provider configured');
    });
    const { stdout, stdin, unmount } = mount(workflow, store, ports);
    try {
      await settle();
      stdin.write('d');
      await settle();
      expect(lastFrame(stdout)).toContain('no provider configured');
      // Still usable: the heuristic hit is right there.
      stdin.write(' ');
      await settle();
      stdin.write('\r');
      expect(await answer).toEqual(['npm test']);
    } finally {
      unmount();
    }
  });
});
