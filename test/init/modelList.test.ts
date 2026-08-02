import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModelIds } from '../../src/init/modelList.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchModelIds', () => {
  it('returns the static curated list for claude without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { models, error } = await fetchModelIds('claude', undefined);
    expect(error).toBeUndefined();
    expect(models.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters non-chat model ids out of the OpenAI list and sorts the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: 'gpt-4o-mini' },
            { id: 'whisper-1' },
            { id: 'tts-1' },
            { id: 'dall-e-3' },
            { id: 'text-embedding-3-small' },
            { id: 'omni-moderation-latest' },
            { id: 'gpt-4o' },
          ],
        }),
      ),
    );
    const { models, error } = await fetchModelIds('openai', 'sk-test');
    expect(error).toBeUndefined();
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('passes NVIDIA and OpenRouter lists through unfiltered, sorted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'z-model' }, { id: 'a-model' }] })),
    );
    const { models } = await fetchModelIds('nvidia', 'nvapi-test');
    expect(models).toEqual(['a-model', 'z-model']);
  });

  it('returns an error result on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401)));
    const { models, error } = await fetchModelIds('openai', 'bad-key');
    expect(models).toEqual([]);
    expect(error).toContain('401');
  });

  it('returns an error result when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { models, error } = await fetchModelIds('openrouter', 'or-test');
    expect(models).toEqual([]);
    expect(error).toContain('network down');
  });

  it('drops malformed entries instead of crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'ok-model' }, { id: 42 }, {}] })),
    );
    const { models, error } = await fetchModelIds('nvidia', 'nvapi-test');
    expect(error).toBeUndefined();
    expect(models).toEqual(['ok-model']);
  });
});
