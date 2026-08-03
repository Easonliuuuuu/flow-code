import { render } from 'ink';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * The skill picker discovers `~/.claude/skills` via the real `homedir()`, not
 * an injectable root — so on a machine with any global/plugin skills
 * installed, these tests would otherwise run against however many hundred
 * skills happen to be on the developer's machine. Pointing HOME at an empty
 * directory for the duration of a test keeps its catalog to exactly the
 * fixture skills it creates.
 */
function withEmptyHome<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'flow-code-empty-home-'));
  return fn().finally(() => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  });
}

/**
 * End-to-end coverage of the skill picker: open it with `s`, toggle a
 * couple of skills, and confirm both the on-screen badge and the workflow
 * file on disk change. Mirrors app.modelPicker.test.ts's structure — see
 * that file for why a real Ink render (not a shallow render) is worth it
 * here: the picker's state machine lives inside App's own useInput handler,
 * not a separately-mountable component.
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
  - id: t
    type: test
    config:
      commands:
        - echo hi
edges:
  - { from: impl, to: rev }
  - { from: rev, to: t }
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
  // A discoverable skill for the picker to list — the picker reads the repo's
  // own `.claude/skills`, independent of how `workflow` itself was loaded.
  const skillDir = join(repoRoot, '.claude', 'skills', 'demo-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: a fixture skill\n---\ndo the thing\n');
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

describe('skill picker end-to-end', () => {
  it('opens with s, toggles a skill, and writes it to the badge and the workflow file', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
    try {
      await settle();
      // Focused node starts as the first in topological order: 'impl'.
      stdin.write('s');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Skills — impl');

      // `demo-skill` is the sole project-source skill, so the project-first
      // sort puts it at cursor 0 — toggle it without moving the cursor.
      stdin.write(' '); // toggle demo-skill on
      await settle();
      stdin.write('\r'); // confirm
      await settle();

      // The badge now fills the node box's type-label row.
      expect(lastFrameLines(stdout).join('\n')).toContain('»demo-skill');
      expect(readFileSync(workflowPath, 'utf8')).toMatch(/skills:\n\s+- demo-skill/);
    } finally {
      unmount();
    }
  });

  it('toggling on then off again writes no skills field', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const before = readFileSync(workflowPath, 'utf8');
    const { stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
    try {
      await settle();
      stdin.write('s');
      await settle();
      stdin.write(' ');
      await settle();
      stdin.write(' '); // toggle back off
      await settle();
      stdin.write('\r');
      await settle();
      expect(readFileSync(workflowPath, 'utf8')).toBe(before);
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
      stdin.write('s');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Skills — impl');
      stdin.write(' ');
      await settle();
      stdin.write('\x1b'); // escape
      await settle();
      expect(readFileSync(workflowPath, 'utf8')).toBe(before);
      expect(lastFrameLines(stdout).join('\n')).not.toContain('Skills — impl');
    } finally {
      unmount();
    }
  });

  it('opens on the Test node too — its optional agent step can now carry skills', async () => {
    const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
    const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
    try {
      await settle();
      // Move focus 'impl' -> 'rev' -> 't' (the test node).
      stdin.write('\t');
      await settle();
      stdin.write('\t');
      await settle();
      stdin.write('s');
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Skills — t');

      stdin.write(' '); // toggle demo-skill on
      await settle();
      stdin.write('\r'); // confirm
      await settle();

      expect(lastFrameLines(stdout).join('\n')).toContain('»demo-skill');
      expect(readFileSync(workflowPath, 'utf8')).toMatch(/skills:\n\s+- demo-skill/);
    } finally {
      unmount();
    }
  });

  it('typing filters the catalog by id/description, and picks the filtered one out from a longer list', () =>
    withEmptyHome(async () => {
      const repoRoot = makeTempGitRepo();
      const workflowPath = join(repoRoot, WORKFLOW_RELATIVE_PATH);
      mkdirSync(join(repoRoot, '.flow-code'), { recursive: true });
      writeFileSync(workflowPath, WORKFLOW_YAML);
      const workflow = workflowFromYaml(WORKFLOW_YAML);
      // Alphabetically, code-review sorts before demo-skill — scrolling to it
      // isn't what's under test here, filtering by a substring is.
      for (const [id, description] of [
        ['demo-skill', 'a fixture skill'],
        ['code-review', 'reviews a diff for common mistakes'],
      ] as const) {
        const dir = join(repoRoot, '.claude', 'skills', id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), `---\ndescription: ${description}\n---\ndo the thing\n`);
      }
      const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
      try {
        await settle();
        stdin.write('s');
        await settle();
        let frame = lastFrameLines(stdout).join('\n');
        expect(frame).toContain('code-review');
        expect(frame).toContain('demo-skill');

        // Typing narrows the list to the one match, by description as well as id.
        stdin.write('review');
        await settle();
        frame = lastFrameLines(stdout).join('\n');
        expect(frame).toContain('search: review');
        expect(frame).toContain('code-review');
        expect(frame).not.toContain('demo-skill');

        // The cursor is on the sole visible match — space toggles it, not
        // whatever the pre-filter cursor position would have been.
        stdin.write(' ');
        await settle();
        stdin.write('\r');
        await settle();
        expect(readFileSync(workflowPath, 'utf8')).toMatch(/skills:\n\s+- code-review/);
      } finally {
        unmount();
      }
    }));

  it('escape clears the query before closing the panel', () =>
    withEmptyHome(async () => {
      const { repoRoot, workflowPath, workflow } = newRepoWithWorkflow();
      const before = readFileSync(workflowPath, 'utf8');
      const { stdout, stdin, unmount } = mountApp(workflow, storeFor(workflow, repoRoot), CLAUDE_CONTEXT);
      try {
        await settle();
        stdin.write('s');
        await settle();
        stdin.write('zzz-no-match');
        await settle();
        expect(lastFrameLines(stdout).join('\n')).toContain('no skill matches "zzz-no-match"');

        stdin.write('\x1b'); // escape: clears the query, panel stays open
        await settle();
        let frame = lastFrameLines(stdout).join('\n');
        expect(frame).toContain('Skills — impl');
        expect(frame).toContain('demo-skill');

        stdin.write('\x1b'); // escape again: now closes the panel
        await settle();
        frame = lastFrameLines(stdout).join('\n');
        expect(frame).not.toContain('Skills — impl');
        expect(readFileSync(workflowPath, 'utf8')).toBe(before);
      } finally {
        unmount();
      }
    }));
});
