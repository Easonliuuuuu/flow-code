import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import type { AgentSessionRequest } from '../src/engine/types.js';
import { RunStateStore } from '../src/runstate/store.js';

/**
 * Drives `SdkSessionRunner` against a stand-in for the Claude Agent SDK's
 * `query()`. Everything here is about how the runner reads that stream —
 * what it treats as the node's result, when it reports usage, and how it
 * unwinds on an abort — none of which the live-API suite can assert cheaply.
 */

function assistant(text: string, over: Record<string, unknown> = {}): unknown {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 's1',
    message: { content: [{ type: 'text', text }], usage: {} },
    ...over,
  };
}

function baseReq(over: Partial<AgentSessionRequest> = {}): AgentSessionRequest {
  return {
    nodeId: 'n1',
    capabilities: capabilitySet('read'),
    rolePrompt: 'r',
    prompt: 'p',
    workingDir: '/repo',
    ...over,
  };
}

function storeFor(): RunStateStore {
  return new RunStateStore({ repoRoot: '/repo', nodeIds: ['n1'] });
}

/** A stream the test feeds by hand, for the turn-by-turn interactive cases. */
function channel(): {
  iterable: AsyncIterable<unknown>;
  push: (message: unknown) => void;
  close: () => void;
} {
  const queued: unknown[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  return {
    push(message) {
      queued.push(message);
      notify?.();
    },
    close() {
      closed = true;
      notify?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queued.length > 0) yield queued.shift();
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    },
  };
}

/**
 * Mocks the SDK and returns a freshly imported runner bound to that mock.
 * `RunInterruptedError` comes back from the same reset module graph — the
 * statically imported class is a different identity after `resetModules`, so
 * an `instanceof` against it would never match.
 */
async function runnerWith(queryImpl: (args: unknown) => unknown) {
  vi.resetModules();
  const hoisted = vi.hoisted(() => ({ query: vi.fn() }));
  hoisted.query.mockImplementation(queryImpl);
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: hoisted.query }));
  const { SdkSessionRunner } = await import('../src/executors/sdkRunner.js');
  const { RunInterruptedError: Interrupted } = await import('../src/engine/types.js');
  return { runner: new SdkSessionRunner(), query: hoisted.query, Interrupted };
}

afterEach(() => {
  vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('SdkSessionRunner.run', () => {
  it("prefers the terminal result message over the last assistant turn", async () => {
    const { runner } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield assistant('thinking out loud');
        yield { type: 'result', subtype: 'success', result: 'the answer', session_id: 's1' };
      },
    }));

    const { finalText } = await runner.run(baseReq(), storeFor());
    expect(finalText).toBe('the answer');
  });

  it('keeps the last assistant text when the result message is empty', async () => {
    const { runner } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield assistant('all I said');
        yield { type: 'result', subtype: 'success', result: '', session_id: 's1' };
      },
    }));

    const { finalText } = await runner.run(baseReq(), storeFor());
    expect(finalText).toBe('all I said');
  });

  it('fails the node when the session ends on a non-success subtype', async () => {
    const { runner } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'error_max_turns', session_id: 's1' };
      },
    }));

    await expect(runner.run(baseReq(), storeFor())).rejects.toThrow(
      'agent session failed: error_max_turns',
    );
  });

  it('streams each assistant turn to onText as it arrives', async () => {
    const { runner } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield assistant('first');
        yield assistant('second');
      },
    }));

    const chunks: string[] = [];
    await runner.run(baseReq({ onText: (c) => chunks.push(c) }), storeFor());
    expect(chunks).toEqual(['first', 'second']);
  });

  it('accumulates token usage onto the node', async () => {
    const { runner } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield assistant('a', {
          message: {
            content: [{ type: 'text', text: 'a' }],
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2,
            },
          },
        });
      },
    }));

    const store = storeFor();
    await runner.run(baseReq(), store);
    expect(store.snapshot().nodes['n1']!.tokens).toEqual({ input: 10, output: 3, cached: 7 });
  });

  it('records a rate-limit window the provider reports', async () => {
    const { runner } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'rate_limit_event',
          rate_limit_info: { rateLimitType: 'five_hour', utilization: 42, status: 'allowed_warning' },
        };
      },
    }));

    const store = storeFor();
    await runner.run(baseReq(), store);
    expect(store.snapshot().rateLimits?.windows['five_hour']).toEqual({
      utilization: 42,
      status: 'allowed_warning',
    });
  });

  it('reports an interrupt as RunInterruptedError, not as the underlying throw', async () => {
    const controller = new AbortController();
    const { runner, Interrupted } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        controller.abort();
        throw new Error('socket closed');
      },
    }));

    await expect(runner.run(baseReq({ signal: controller.signal }), storeFor())).rejects.toBeInstanceOf(
      Interrupted,
    );
  });

  it('does not report success when an aborted stream simply ends', async () => {
    const controller = new AbortController();
    const { runner, Interrupted } = await runnerWith(() => ({
      async *[Symbol.asyncIterator]() {
        yield assistant('partial work');
        controller.abort();
      },
    }));

    await expect(runner.run(baseReq({ signal: controller.signal }), storeFor())).rejects.toBeInstanceOf(
      Interrupted,
    );
  });
});

describe('SdkSessionRunner.openInteractive', () => {
  it('resolves a turn with the text accumulated before its result message', async () => {
    const stream = channel();
    const { runner } = await runnerWith(() => stream.iterable);
    const session = await runner.openInteractive(baseReq(), storeFor());

    const reply = session.send('hello');
    stream.push(assistant('part one'));
    stream.push(assistant('part two'));
    stream.push({ type: 'result', subtype: 'success', result: '', session_id: 's1' });

    expect(await reply).toBe('part one\npart two');
    stream.close();
    await session.end();
  });

  it('starts each turn clean rather than repeating the previous one', async () => {
    const stream = channel();
    const { runner } = await runnerWith(() => stream.iterable);
    const session = await runner.openInteractive(baseReq(), storeFor());

    const first = session.send('one');
    stream.push(assistant('reply one'));
    stream.push({ type: 'result', subtype: 'success', result: '', session_id: 's1' });
    expect(await first).toBe('reply one');

    const second = session.send('two');
    stream.push(assistant('reply two'));
    stream.push({ type: 'result', subtype: 'success', result: '', session_id: 's1' });
    expect(await second).toBe('reply two');

    stream.close();
    await session.end();
  });

  it('reports the session id once, so --resume has something to continue', async () => {
    const stream = channel();
    const { runner } = await runnerWith(() => stream.iterable);
    const seen: string[] = [];
    const session = await runner.openInteractive(
      baseReq({ onSessionId: (id) => seen.push(id) }),
      storeFor(),
    );

    const reply = session.send('hi');
    stream.push(assistant('a'));
    stream.push(assistant('b'));
    stream.push({ type: 'result', subtype: 'success', result: '', session_id: 's1' });
    await reply;

    expect(seen).toEqual(['s1']);
    stream.close();
    await session.end();
  });

  it('rejects a pending turn when the stream ends without answering it', async () => {
    const stream = channel();
    const { runner } = await runnerWith(() => stream.iterable);
    const session = await runner.openInteractive(baseReq(), storeFor());

    const pending = session.send('anyone there?');
    stream.close();

    await expect(pending).rejects.toThrow('agent session ended before responding');
    await session.end();
  });

  it('rejects a send made after the run was interrupted', async () => {
    const controller = new AbortController();
    const stream = channel();
    const { runner, Interrupted } = await runnerWith(() => stream.iterable);
    const session = await runner.openInteractive(baseReq({ signal: controller.signal }), storeFor());

    controller.abort();
    await expect(session.send('too late')).rejects.toBeInstanceOf(Interrupted);

    stream.close();
    await session.end();
  });

  it('reports an interrupt mid-turn as RunInterruptedError', async () => {
    const controller = new AbortController();
    const stream = channel();
    const { runner, Interrupted } = await runnerWith(() => stream.iterable);
    const session = await runner.openInteractive(baseReq({ signal: controller.signal }), storeFor());

    const pending = session.send('working on it');
    controller.abort();
    stream.close();

    await expect(pending).rejects.toBeInstanceOf(Interrupted);
    await session.end();
  });
});
