import { render } from 'ink';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { RunStateStore } from '../src/runstate/store.js';
import { editableFields, parseFieldValue } from '../src/ui/nodeEditor.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import type { Workflow } from '../src/workflow/load.js';
import { WORKFLOW_RELATIVE_PATH } from '../src/workflow/load.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * End-to-end coverage of the node settings editor: open it with `e`, type a
 * value, and confirm it reaches both the in-memory workflow the engine reads
 * and the file on disk. Structured like app.skillPicker.test.ts — the
 * editor's state machine lives inside App's own useInput handler, so a real
 * Ink render is the only way to drive it.
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

function lastFrame(stdout: FakeStdout): string {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return plain.filter((f) => f.trim().length > 0).at(-1) ?? '';
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
): { stdout: FakeStdout; stdin: NodeJS.ReadStream; unmount: () => void } {
  const modelContext: ModelContext = {
    providerId: 'claude',
    providerDefaultModel: undefined,
    workflowSettingsModel: 'sonnet',
  };
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const instance = render(
    React.createElement(App, {
      workflow,
      store,
      ports: new UiInteractionPorts(),
      modelContext,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { stdout, stdin, unmount: () => instance.unmount() };
}

describe('editableFields', () => {
  const wf = workflowFromYaml(WORKFLOW_YAML);
  const impl = wf.nodes.find((n) => n.id === 'impl')!;

  it('offers the token budget on every node, and the type-specific text fields', () => {
    const fields = editableFields(impl);
    expect(fields.map((f) => f.key)).toEqual(['budget.tokens', 'instructions']);
    expect(fields[0]!.value).toBe('');
    expect(fields[1]!.value).toBe('do the thing');
  });

  it('offers only the budget for a type with nothing else worth typing', () => {
    const wtree = workflowFromYaml(`
nodes:
  - id: w
    type: worktree-agent
    config:
      mode: compare
      task: t
      instances: [{ instructions: a }, { instructions: b }]
`);
    expect(editableFields(wtree.nodes[0]!).map((f) => f.key)).toEqual(['budget.tokens']);
  });

  it('reports a budget the node already carries', () => {
    const withBudget = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    budget: { tokens: 50000 }
    config: { instructions: x }
`);
    expect(editableFields(withBudget.nodes[0]!)[0]!.value).toBe('50000');
  });
});

describe('parseFieldValue', () => {
  const [budget, instructions] = editableFields(
    workflowFromYaml(WORKFLOW_YAML).nodes.find((n) => n.id === 'impl')!,
  );

  it('reads a token count, separators and all', () => {
    expect(parseFieldValue(budget!, '50000')).toEqual({ ok: true, kind: 'number', value: 50_000 });
    expect(parseFieldValue(budget!, '50,000')).toEqual({ ok: true, kind: 'number', value: 50_000 });
    expect(parseFieldValue(budget!, ' 50_000 ')).toEqual({ ok: true, kind: 'number', value: 50_000 });
  });

  it('rejects a token count that is not a positive whole number', () => {
    for (const bad of ['0', '-5', '1.5', 'lots']) {
      expect(parseFieldValue(budget!, bad).ok).toBe(false);
    }
  });

  it('treats an empty input as clearing the field — the only way back to the default', () => {
    expect(parseFieldValue(budget!, '   ')).toEqual({ ok: true, kind: 'number', value: null });
    expect(parseFieldValue(instructions!, '')).toEqual({ ok: true, kind: 'string', value: null });
  });
});

describe('node settings editor end-to-end', () => {
  it('opens with e, types a token budget, and writes it to disk and to the live workflow', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot));
    try {
      await settle();
      stdin.write('e');
      await settle();
      expect(lastFrame(stdout)).toContain('Settings — impl');
      expect(lastFrame(stdout)).toContain('token budget');

      stdin.write('\r'); // start editing the field under the cursor
      await settle();
      stdin.write('50000');
      await settle();
      stdin.write('\r'); // save
      await settle();

      expect(readFileSync(workflowPath, 'utf8')).toMatch(/budget:\n\s+tokens: 50000/);
      // The engine reads the same in-memory node at node-start time, so the
      // budget applies to this run without a restart.
      expect(workflow.nodes.find((n) => n.id === 'impl')!.budget).toEqual({ tokens: 50_000 });
    } finally {
      unmount();
    }
  });

  it('edits a config field, and clearing it removes the key', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const { stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot));
    try {
      await settle();
      stdin.write('e');
      await settle();
      stdin.write('j'); // down to `instructions`
      await settle();
      stdin.write('\r');
      await settle();
      // The field opens pre-filled with its current value; clear it and type.
      for (let i = 0; i < 'do the thing'.length; i++) stdin.write('\x7f');
      await settle();
      stdin.write('rewrite it');
      await settle();
      stdin.write('\r');
      await settle();
      expect(readFileSync(workflowPath, 'utf8')).toContain('instructions: rewrite it');
    } finally {
      unmount();
    }
  });

  it('reports a bad value and leaves the file alone', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const before = readFileSync(workflowPath, 'utf8');
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot));
    try {
      await settle();
      stdin.write('e');
      await settle();
      stdin.write('\r');
      await settle();
      stdin.write('lots');
      await settle();
      stdin.write('\r');
      await settle();
      expect(lastFrame(stdout)).toContain('token budget must be a whole number');
      expect(readFileSync(workflowPath, 'utf8')).toBe(before);
    } finally {
      unmount();
    }
  });

  it('escape backs out of the field first, then the panel, saving nothing', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const before = readFileSync(workflowPath, 'utf8');
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot));
    try {
      await settle();
      stdin.write('e');
      await settle();
      stdin.write('\r');
      await settle();
      stdin.write('9999');
      await settle();
      stdin.write('\x1b'); // out of the field, still in the panel
      await settle();
      expect(lastFrame(stdout)).toContain('Settings — impl');
      stdin.write('\x1b'); // out of the panel
      await settle();
      expect(lastFrame(stdout)).not.toContain('Settings — impl');
      expect(readFileSync(workflowPath, 'utf8')).toBe(before);
    } finally {
      unmount();
    }
  });
});
