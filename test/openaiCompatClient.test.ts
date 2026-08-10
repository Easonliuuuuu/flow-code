import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callOpenAiCompatChat,
  OpenAiCompatApiError,
  type ChatMessage,
} from '../src/executors/openaiCompatClient.js';
import type { CompatToolDef } from '../src/harness/compatTools.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
};

const NO_TOOLS: CompatToolDef[] = [];

function chatOpts() {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'model-1',
    messages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
    tools: NO_TOOLS,
    apiKeys: ['test-key'],
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

  it('retries a request that throws (e.g. a stalled connection hitting the per-attempt timeout)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'TimeoutError'))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAiCompatChat(chatOpts());

    expect(result.content).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the caller aborts, and reports it distinctly from a timeout', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAiCompatChat({ ...chatOpts(), signal: controller.signal })).rejects.toBeInstanceOf(
      OpenAiCompatApiError,
    );
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

describe('callOpenAiCompatChat usage reporting', () => {
  it('splits cached prompt tokens out of the input count so a total never double-counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...OK_BODY,
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 120,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        }),
      ),
    );
    const onUsage = vi.fn();

    await callOpenAiCompatChat({ ...chatOpts(), onUsage });

    expect(onUsage).toHaveBeenCalledWith({ input: 200, output: 120, cacheRead: 800 });
  });

  it('stays quiet when the provider reports no usage at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(OK_BODY)));
    const onUsage = vi.fn();

    await callOpenAiCompatChat({ ...chatOpts(), onUsage });

    expect(onUsage).not.toHaveBeenCalled();
  });
});

describe('callOpenAiCompatChat key rotation', () => {
  function authHeader(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string | undefined {
    return (fetchMock.mock.calls[callIndex]![1].headers as Record<string, string>).Authorization;
  }

  it('rotates to the next key once the first key exhausts its retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429 }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ status: 429 }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ status: 429 }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ status: 429 }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAiCompatChat({ ...chatOpts(), apiKeys: ['key-1', 'key-2'] });

    expect(result.content).toBe('hi');
    // 4 calls (initial + 3 retries) on key-1, then 1 call on key-2.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(authHeader(fetchMock, 0)).toBe('Bearer key-1');
    expect(authHeader(fetchMock, 3)).toBe('Bearer key-1');
    expect(authHeader(fetchMock, 4)).toBe('Bearer key-2');
  });

  it('throws once every key exhausts its retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 429 }, 429, { 'retry-after': '0' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAiCompatChat({ ...chatOpts(), apiKeys: ['key-1', 'key-2'] })).rejects.toBeInstanceOf(
      OpenAiCompatApiError,
    );
    // 4 calls per key (initial + 3 retries) across 2 keys.
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('does not rotate keys on a non-retryable client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAiCompatChat({ ...chatOpts(), apiKeys: ['key-1', 'key-2'] })).rejects.toBeInstanceOf(
      OpenAiCompatApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
