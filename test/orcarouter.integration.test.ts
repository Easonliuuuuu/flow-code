/**
 * Live smoke test for the OrcaRouter runner, mirroring
 * openai.integration.test.ts: a hidden marker proves the real tool-call loop
 * ran against the live API, not merely that some model answered a prompt.
 * Permission-boundary behavior is not re-tested live here — it is provider-
 * agnostic harness logic (compatHarness.test.ts) exercised identically by
 * every OpenAiCompatSessionRunner config, OrcaRouter's included, since this
 * runner overrides no methods (see design.md in
 * openspec/changes/add-orcarouter-provider).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { OrcaRouterSessionRunner } from '../src/executors/orcarouterRunner.js';
import { RunStateStore } from '../src/runstate/store.js';

const hasCredentials = Boolean(process.env['ORCAROUTER_API_KEY'] || process.env['ORCAROUTER_API_KEY_2']);
// $0-priced catalog ids (see openspec/changes/add-orcarouter-provider/design.md's
// "Free Models" finding) — used explicitly so this suite never bills the key
// it runs against, regardless of that key's balance.
const FREE_MODEL_A = 'deepseek/deepseek-v4-flash-free';
const FREE_MODEL_B = 'qwen/qwen3.8-27b-free';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-orcarouter-integration-'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!hasCredentials)('OrcaRouter live integration', () => {
  it('runs a real read_file tool call and returns the requested file content', async () => {
    const dir = tempDir();
    const marker = 'ORCAROUTER_LIVE_MARKER_7f2c';
    writeFileSync(join(dir, 'marker.txt'), `${marker}\n`);
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['smoke'] });

    const runner = new OrcaRouterSessionRunner();
    const { finalText } = await runner.run(
      {
        nodeId: 'smoke',
        capabilities: capabilitySet('read'),
        rolePrompt: 'You are a smoke-test agent. Do not modify files or use shell commands.',
        prompt:
          'Use the read_file tool to read marker.txt from the working directory, then include its exact contents in your final answer. ' +
          'Do not guess the contents.',
        workingDir: dir,
        model: FREE_MODEL_A,
      },
      store,
    );

    expect(finalText).toContain(marker);
    const readCalls = store.activityFor('smoke').filter((entry) => entry.tool === 'read_file');
    expect(readCalls.length).toBeGreaterThan(0);
    expect(readCalls.every((entry) => entry.decision === 'allowed')).toBe(true);
    // Confirms token accounting accumulates against real usage, not just the
    // mocked-fetch shape asserted in test/openaiCompatRunner.test.ts.
    expect(store.tokensFor('smoke')).toBeGreaterThan(0);
  }, 120_000);

  it("honors a node's config.model override against the real API, not the runner's baked-in default", async () => {
    const dir = tempDir();
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['smoke'] });
    // Two different free ids, neither of which is DEFAULT_ORCAROUTER_MODEL —
    // proves the override reaches the request rather than falling back.
    const overrideModel = FREE_MODEL_B;

    const realFetch = globalThis.fetch;
    const requestBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: Parameters<typeof fetch>) => {
        const init = args[1];
        if (init?.body) requestBodies.push(JSON.parse(init.body as string));
        return realFetch(...args);
      }),
    );

    const runner = new OrcaRouterSessionRunner();
    const { finalText } = await runner.run(
      {
        nodeId: 'smoke',
        capabilities: capabilitySet(),
        rolePrompt: 'You are a smoke-test agent.',
        prompt: 'Reply with exactly: override-ok',
        workingDir: dir,
        model: overrideModel,
      },
      store,
    );

    expect(finalText.toLowerCase()).toContain('override-ok');
    expect(requestBodies.length).toBeGreaterThan(0);
    // Direct proof the per-node model reached the live request, not the
    // runner's baked-in default (openai/gpt-4o-mini).
    expect((requestBodies[0] as { model: string }).model).toBe(overrideModel);
  }, 120_000);
});
