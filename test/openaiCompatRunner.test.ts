import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import type { AgentSessionRequest } from '../src/engine/types.js';
import { OpenAiSessionRunner, OPENAI_BASE_URL } from '../src/executors/openaiRunner.js';
import { OpenRouterSessionRunner, OPENROUTER_BASE_URL } from '../src/executors/openrouterRunner.js';
import { RunStateStore } from '../src/runstate/store.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function chatCompletion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

function baseRequest(overrides: Partial<AgentSessionRequest> = {}): AgentSessionRequest {
  return {
    nodeId: 'impl',
    capabilities: capabilitySet('read'),
    rolePrompt: 'You review things.',
    prompt: 'Say hi',
    workingDir: '/repo',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OpenAiSessionRunner', () => {
  beforeEach(() => vi.stubEnv('OPENAI_API_KEY', 'sk-test'));

  it('calls the OpenAI chat-completions endpoint with the configured key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chatCompletion('all done')));
    vi.stubGlobal('fetch', fetchMock);
    const runner = new OpenAiSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    const { finalText } = await runner.run(baseRequest(), store);
    expect(finalText).toBe('all done');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${OPENAI_BASE_URL}/chat/completions`);
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('throws a clear error when OPENAI_API_KEY is unset', async () => {
    vi.unstubAllEnvs();
    const runner = new OpenAiSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(runner.run(baseRequest(), store)).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe('OpenRouterSessionRunner', () => {
  beforeEach(() => vi.stubEnv('OPENROUTER_API_KEY', 'or-test'));

  it('calls the OpenRouter chat-completions endpoint with the configured key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chatCompletion('all done')));
    vi.stubGlobal('fetch', fetchMock);
    const runner = new OpenRouterSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    const { finalText } = await runner.run(baseRequest(), store);
    expect(finalText).toBe('all done');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer or-test');
  });

  it('throws a clear error when OPENROUTER_API_KEY is unset', async () => {
    vi.unstubAllEnvs();
    const runner = new OpenRouterSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(runner.run(baseRequest(), store)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});
