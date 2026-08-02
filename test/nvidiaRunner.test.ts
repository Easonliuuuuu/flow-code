import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import type { NvidiaMessage } from '../src/executors/nvidiaClient.js';
import { NvidiaSessionRunner } from '../src/executors/nvidiaRunner.js';
import { RunInterruptedError, type AgentSessionRequest } from '../src/engine/types.js';
import { RunStateStore } from '../src/runstate/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-nvidia-runner-test-'));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function chatCompletion(message: NvidiaMessage): unknown {
  return { choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] };
}

function baseRequest(overrides: Partial<AgentSessionRequest> = {}): AgentSessionRequest {
  return {
    nodeId: 'impl',
    capabilities: capabilitySet('read', 'edit', 'exec'),
    rolePrompt: 'You implement things.',
    prompt: 'Write hello.txt containing hello',
    workingDir: tempDir(),
    ...overrides,
  };
}

describe('NvidiaSessionRunner', () => {
  beforeEach(() => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-key');
    // Pin the rotation pool to exactly one key regardless of what's set in the
    // host shell (e.g. a real NVIDIA_API_KEY_2 for local rotation testing) —
    // otherwise these tests would fire real requests at a live account.
    vi.stubEnv('NVIDIA_API_KEY_2', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns the final text when the model responds with no tool calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: 'all done' }))),
    );
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    const { finalText } = await runner.run(baseRequest(), store);
    expect(finalText).toBe('all done');
  });

  it('executes a write_file tool call, feeds the result back, and finishes on the next turn', async () => {
    const dir = tempDir();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          chatCompletion({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hello' }) },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(chatCompletion({ role: 'assistant', content: 'wrote it' })));
    vi.stubGlobal('fetch', fetchMock);

    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['impl'] });
    const { finalText } = await runner.run(baseRequest({ workingDir: dir }), store);

    expect(finalText).toBe('wrote it');
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const activity = store.activityFor('impl');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ tool: 'write_file', decision: 'allowed' });

    // The second request's message history includes the tool result.
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(secondCallBody.messages.some((m: NvidiaMessage) => m.role === 'tool')).toBe(true);
  });

  it('denies a tool call outside the capability set and feeds the denial back as a tool result, without throwing', async () => {
    const dir = tempDir();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          chatCompletion({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'run_shell', arguments: JSON.stringify({ command: 'git push origin main' }) },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(chatCompletion({ role: 'assistant', content: 'ok, skipping that' })));
    vi.stubGlobal('fetch', fetchMock);

    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['impl'] });
    // Implement's real capabilities (read/edit/exec) have no git-write.
    const { finalText } = await runner.run(baseRequest({ workingDir: dir }), store);

    expect(finalText).toBe('ok, skipping that');
    const activity = store.activityFor('impl');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ decision: 'denied', missingCapability: 'git-write' });
  });

  it('fails after exceeding the tool-call iteration cap rather than looping forever', async () => {
    const dir = tempDir();
    const alwaysToolCall = jsonResponse(
      chatCompletion({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-x', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
        ],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(alwaysToolCall.clone())),
    );
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: dir, nodeIds: ['impl'] });
    await expect(runner.run(baseRequest({ workingDir: dir }), store)).rejects.toThrow(
      /iterations without finishing/,
    );
  });

  it('openInteractive supports a multi-turn conversation, accumulating history across sends', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(chatCompletion({ role: 'assistant', content: 'hi there' })))
      .mockResolvedValueOnce(jsonResponse(chatCompletion({ role: 'assistant', content: 'got it' })));
    vi.stubGlobal('fetch', fetchMock);
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['chat'] });
    const session = await runner.openInteractive(baseRequest({ nodeId: 'chat' }), store);

    expect(await session.send('open a discussion')).toBe('hi there');
    expect(await session.send('sounds good')).toBe('got it');
    await session.end();

    const secondCallMessages = JSON.parse(fetchMock.mock.calls[1]![1].body as string).messages;
    // system + first user + first assistant reply + second user
    expect(secondCallMessages).toHaveLength(4);
    expect(secondCallMessages[secondCallMessages.length - 1]).toMatchObject({
      role: 'user',
      content: 'sounds good',
    });
  });

  it('openInteractive replays the prior transcript into history when resuming', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: 'continuing' })));
    vi.stubGlobal('fetch', fetchMock);
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['chat'] });
    store.appendDiscussMessage('chat', { role: 'assistant', text: 'earlier question' });
    store.appendDiscussMessage('chat', { role: 'user', text: 'earlier answer' });

    const session = await runner.openInteractive(
      baseRequest({ nodeId: 'chat', resumeSessionId: 'whatever' }),
      store,
    );
    await session.send('one more thing');

    const sentMessages = JSON.parse(fetchMock.mock.calls[0]![1].body as string).messages;
    // system + 2 replayed transcript entries + new user message
    expect(sentMessages).toHaveLength(4);
    expect(sentMessages[1]).toMatchObject({ role: 'assistant', content: 'earlier question' });
    expect(sentMessages[2]).toMatchObject({ role: 'user', content: 'earlier answer' });
  });

  it('throws RunInterruptedError immediately if already interrupted, without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(
      runner.run(baseRequest({ signal: controller.signal }), store),
    ).rejects.toBeInstanceOf(RunInterruptedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the abort signal to the underlying API call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: 'all done' })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await runner.run(baseRequest({ signal: controller.signal }), store);
    // Not the same object — it's combined with a per-attempt timeout signal —
    // but it must still reflect the caller's abort.
    const passedSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    expect(passedSignal.aborted).toBe(false);
    controller.abort();
    expect(passedSignal.aborted).toBe(true);
  });

  it('throws a clear error when NVIDIA_API_KEY is unset', async () => {
    vi.stubEnv('NVIDIA_API_KEY', undefined);
    vi.stubEnv('NVIDIA_API_KEY_2', undefined);
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(runner.run(baseRequest(), store)).rejects.toThrow(/NVIDIA_API_KEY/);
  });
});
