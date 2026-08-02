import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callOpenAiCompatChat,
  OpenAiCompatApiError,
  type ChatMessage,
} from '../src/executors/openaiCompatClient.js';
import type { NvidiaToolDef } from '../src/harness/nvidiaTools.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
};

const NO_TOOLS: NvidiaToolDef[] = [];

function chatOpts() {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'model-1',
    messages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
    tools: NO_TOOLS,
    apiKey: 'test-key',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('callOpenAiCompatChat retries', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429, title: 'Too Many Requests' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAiCompatChat(chatOpts());

    expect(result.content).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('gives up after exhausting retries when still rate-limited', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 429, title: 'Too Many Requests' }, 429, { 'retry-after': '0' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAiCompatChat(chatOpts())).rejects.toBeInstanceOf(OpenAiCompatApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does not retry a 400 client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAiCompatChat(chatOpts())).rejects.toBeInstanceOf(OpenAiCompatApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the first response body when it succeeds immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAiCompatChat(chatOpts());
    expect(result.content).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
