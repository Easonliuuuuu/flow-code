/**
 * Minimal live smoke test for the OpenAI chat-completions runner. It uses a
 * hidden marker so a successful response proves the real tool-call loop ran,
 * not merely that the model answered a prompt. Permission-boundary behavior
 * remains covered by the deterministic harness tests and Claude canary.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { OpenAiSessionRunner } from '../src/executors/openaiRunner.js';
import { RunStateStore } from '../src/runstate/store.js';

const hasCredentials = Boolean(process.env['OPENAI_API_KEY'] || process.env['OPENAI_API_KEY_2']);
const integrationModel = process.env['OPENAI_INTEGRATION_MODEL'];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-openai-integration-'));
}

describe.skipIf(!hasCredentials)('OpenAI live integration', () => {
  it('runs a real read_file tool call and returns the requested file content', async () => {
    const dir = tempDir();
    const marker = 'OPENAI_LIVE_MARKER_4b91';
    writeFileSync(join(dir, 'marker.txt'), `${marker}\n`);
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['smoke'] });

    const runner = new OpenAiSessionRunner();
    const { finalText } = await runner.run(
      {
        nodeId: 'smoke',
        capabilities: capabilitySet('read'),
        rolePrompt: 'You are a smoke-test agent. Do not modify files or use shell commands.',
        prompt:
          'Use the read_file tool to read marker.txt from the working directory, then include its exact contents in your final answer. ' +
          'Do not guess the contents.',
        workingDir: dir,
        ...(integrationModel !== undefined ? { model: integrationModel } : {}),
      },
      store,
    );

    expect(finalText).toContain(marker);
    const readCalls = store.activityFor('smoke').filter((entry) => entry.tool === 'read_file');
    expect(readCalls.length).toBeGreaterThan(0);
    expect(readCalls.every((entry) => entry.decision === 'allowed')).toBe(true);
  }, 120_000);
});
