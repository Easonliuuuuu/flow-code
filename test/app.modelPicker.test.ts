import { render } from 'ink';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { RunStateStore } from '../src/runstate/store.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import type { Workflow } from '../src/workflow/load.js';
import { WORKFLOW_RELATIVE_PATH } from '../src/workflow/load.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * End-to-end coverage of the model picker: open it with `m`, pick a model,
 * and confirm both the on-screen badge and the workflow file on disk change.
 * Uses the 'claude' provider, whose model list (`CLAUDE_MODELS` in
 * `src/init/modelList.ts`) is a static in-process constant — no network
 * mocking needed to get a deterministic list, though it still resolves
 * asynchronously and needs its own render tick to reach the screen.
 */

const WORKFLOW_YAML = `settings:
  model: sonnet

nodes:
  - id: impl
    type: implement
    config:
      instructions: do the thing
  - id: rev
    type: review
edges:
  - { from: impl, to: rev }
`;

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

function lastFrameLines(stdout: FakeStdout): string[] {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return (plain.filter((f) => f.trim().length > 0).at(-1) ?? '').split('\n');
}

function newRepoWithWorkflow(): { repoRoot: string; workflowPath: string; workflow: Workflow } {
  const repoRoot = makeTempGitRepo();
  const workflowPath = join(repoRoot, WORKFLOW_RELATIVE_PATH);
  mkdirSync(join(repoRoot, '.flow-code'), { recursive: true });
  writeFileSync(workflowPath, WORKFLOW_YAML);
  return { repoRoot, workflowPath, workflow: workflowFromYaml(WORKFLOW_YAML) };
}

function mountApp(
  workflow: Workflow,
  store: RunStateStore,
  modelContext: ModelContext,
): { stdout: FakeStdout; stdin: NodeJS.ReadStream; unmount: () => void } {
  const ports = new UiInteractionPorts();
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

const CLAUDE_CONTEXT: ModelContext = {
  providerId: 'claude',
  providerDefaultModel: undefined,
  workflowSettingsModel: 'sonnet',
};

describe('model picker end-to-end', () => {
  it('opens with m, picks a model, and writes it to the badge and the workflow file', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
    try {
      await settle();
      // Focused node starts as the first in topological order: 'impl'.
      stdin.write('m');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Model — impl');
      await settle(300);
      expect(lastFrameLines(stdout).join('\n')).toContain('claude-opus-5');

      // Move down to claude-opus-5 (index 1 of CLAUDE_MODELS) and confirm.
      stdin.write('j');
      await settle();
      stdin.write('\r');
      await settle();

      // The badge now fills the node box's type-label row.
      expect(lastFrameLines(stdout).join('\n')).toContain('claude-opus-5');
      expect(readFileSync(workflowPath, 'utf8')).toContain('model: claude-opus-5');
    } finally {
      unmount();
    }
  });

  it('is read-only-with-a-notice on a done node, but a change still lands on disk for a future re-run', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const store = storeFor(workflow, repoRoot);
    store.setStatus('impl', 'done');
    const { stdout, stdin, unmount } = mountApp(workflow, store, CLAUDE_CONTEXT);
    try {
      await settle();
      stdin.write('m');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('already done');
      await settle(300); // let the model list load before selecting from it

      stdin.write('j');
      await settle();
      stdin.write('\r');
      await settle();

      expect(readFileSync(workflowPath, 'utf8')).toContain('model: claude-opus-5');
    } finally {
      unmount();
    }
  });

  it('dismissing with escape leaves the file untouched', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
    try {
      const before = readFileSync(workflowPath, 'utf8');
      await settle();
      stdin.write('m');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Model — impl');
      stdin.write('\x1b'); // escape
      await settle();
      expect(readFileSync(workflowPath, 'utf8')).toBe(before);
      expect(lastFrameLines(stdout).join('\n')).not.toContain('Model — impl');
    } finally {
      unmount();
    }
  });

  it('declines on a node type with no model field, and on a missing provider, without opening a panel', async () => {
    const { repoRoot, workflow } = newRepoWithWorkflow();
    const NO_PROVIDER: ModelContext = {
      providerId: undefined,
      providerDefaultModel: undefined,
      workflowSettingsModel: undefined,
    };
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), NO_PROVIDER);
    try {
      await settle();
      stdin.write('m');
      await settle();
      const frame = lastFrameLines(stdout).join('\n');
      expect(frame).toContain('flow-code init');
      expect(frame).not.toContain('Model — impl');
    } finally {
      unmount();
    }
  });
});
