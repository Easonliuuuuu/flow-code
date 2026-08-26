/**
 * Minimal live smoke test for the Codex SDK runner. Unlike the Claude suite,
 * this is opt-in even when a local Codex login exists: set
 * CODEX_INTEGRATION=1 to acknowledge that the test consumes subscription/API
 * usage. It is kept separate because Codex enforces capabilities through a
 * thread-wide sandbox rather than per-tool hooks.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { CodexSessionRunner } from '../src/executors/codexRunner.js';
import { RunStateStore } from '../src/runstate/store.js';

const optedIn = process.env['CODEX_INTEGRATION'] === '1';
const hasCodexLogin = existsSync(join(process.env['CODEX_HOME'] || join(homedir(), '.codex'), 'auth.json'));
const hasCredentials = Boolean(process.env['CODEX_API_KEY'] || process.env['OPENAI_API_KEY'] || hasCodexLogin);
const integrationModel = process.env['CODEX_INTEGRATION_MODEL'];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-codex-integration-'));
}

describe.skipIf(!optedIn || !hasCredentials)('Codex live integration', () => {
  it('runs a real sandboxed shell turn and returns the requested file content', async () => {
    const dir = tempDir();
    const marker = 'CODEX_LIVE_MARKER_7c2a';
    writeFileSync(join(dir, 'marker.txt'), `${marker}\n`);
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['smoke'] });

    const runner = new CodexSessionRunner();
    const { finalText } = await runner.run(
      {
        nodeId: 'smoke',
        capabilities: capabilitySet('read'),
        rolePrompt: 'You are a smoke-test agent. Do not modify files or use the network.',
        prompt:
          'Use the shell to read marker.txt from the working directory, then include its exact contents in your final answer. ' +
          'Do not guess the contents.',
        workingDir: dir,
        ...(integrationModel !== undefined ? { model: integrationModel } : {}),
      },
      store,
    );

    expect(finalText).toContain(marker);
    const shellCalls = store.activityFor('smoke').filter((entry) => entry.tool === 'run_shell');
    expect(shellCalls.length).toBeGreaterThan(0);
    expect(shellCalls.some((entry) => entry.exitStatus === 0)).toBe(true);
  }, 120_000);
});
