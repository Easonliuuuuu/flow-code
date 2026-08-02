/**
 * Real network calls to NVIDIA's NIM API — no mocking. Requires a live
 * NVIDIA_API_KEY; skips entirely (not "fails") when it's absent so this
 * never blocks `npm test` or CI for contributors without the secret. Run
 * explicitly via `npm run test:integration`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { NvidiaSessionRunner } from '../src/executors/nvidiaRunner.js';
import { RunStateStore } from '../src/runstate/store.js';

const hasKey = Boolean(process.env['NVIDIA_API_KEY']);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-nvidia-integration-'));
}

describe.skipIf(!hasKey)('NVIDIA API integration', () => {
  it('fixes a real bug end-to-end: reads, edits, verifies via a shell command', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'math.js'),
      'export function add(a, b) {\n  return a - b; // bug: should add\n}\n',
    );
    writeFileSync(
      join(dir, 'test.js'),
      "import assert from 'node:assert/strict';\nimport { add } from './math.js';\n" +
        "assert.equal(add(2, 3), 5);\nconsole.log('all tests passed');\n",
    );

    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['impl'] });
    const { finalText } = await runner.run(
      {
        nodeId: 'impl',
        capabilities: capabilitySet('read', 'edit', 'exec'),
        rolePrompt: 'You are the implementation step of a coding workflow.',
        prompt:
          'Fix the bug in math.js: add(a, b) should return a + b, not a - b. ' +
          'Run `node test.js` with run_shell to confirm the fix.',
        workingDir: dir,
      },
      store,
    );

    expect(finalText.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toContain('a + b');
    const shellCalls = store.activityFor('impl').filter((e) => e.tool === 'run_shell');
    expect(shellCalls.some((e) => e.exitStatus === 0)).toBe(true);
  });

  it('never mutates the file when the capability set is read-only', async () => {
    const dir = tempDir();
    const original = 'export function add(a, b) {\n  return a - b;\n}\n';
    writeFileSync(join(dir, 'math.js'), original);

    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['review'] });
    await runner.run(
      {
        nodeId: 'review',
        capabilities: capabilitySet('read'),
        rolePrompt: 'You are the code review step of a coding workflow. You cannot edit files.',
        prompt: 'Read math.js and try to fix the bug (a - b should be a + b) by editing the file.',
        workingDir: dir,
      },
      store,
    );

    // Structural enforcement, not the model's word for it: the tool was
    // never offered, so the file must be exactly what it started as.
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(original);
    const activity = store.activityFor('review');
    expect(activity.every((e) => e.tool !== 'write_file' && e.tool !== 'edit_file')).toBe(true);
  });
});
