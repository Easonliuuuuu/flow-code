import { describe, expect, it, vi } from 'vitest';
import { createModelListLoader } from '../src/ui/modelListLoader.js';

describe('createModelListLoader', () => {
  it('starts loading and reports the loaded models once the fetch resolves', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ models: ['a', 'b'] });
    const onChange = vi.fn();
    const loader = createModelListLoader('nvidia', 'key', onChange, fetchFn);

    expect(loader.getState()).toEqual({ status: 'loading' });
    loader.ensureLoaded();
    expect(loader.getState()).toEqual({ status: 'loading' });
    await vi.waitFor(() => expect(loader.getState().status).toBe('loaded'));

    expect(loader.getState()).toEqual({ status: 'loaded', models: ['a', 'b'] });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('nvidia', 'key');
  });

  it('surfaces a failed fetch as state, never throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ models: [], error: 'network down' });
    const onChange = vi.fn();
    const loader = createModelListLoader('openai', undefined, onChange, fetchFn);

    loader.ensureLoaded();
    await vi.waitFor(() => expect(loader.getState().status).toBe('failed'));

    expect(loader.getState()).toEqual({ status: 'failed', error: 'network down' });
  });

  it('fetches at most once per loader, no matter how many times ensureLoaded is called', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ models: ['a'] });
    const loader = createModelListLoader('openrouter', 'key', () => {}, fetchFn);

    loader.ensureLoaded();
    loader.ensureLoaded();
    loader.ensureLoaded();
    await vi.waitFor(() => expect(loader.getState().status).toBe('loaded'));
    loader.ensureLoaded();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
