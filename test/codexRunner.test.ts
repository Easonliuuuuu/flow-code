import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { RunInterruptedError, type AgentSessionRequest } from '../src/engine/types.js';
import { RunStateStore } from '../src/runstate/store.js';

type FakeThread = {
  id: string | null;
  runStreamed: (input: string, opts?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<unknown> }>;
};

const hoisted = vi.hoisted(() => ({
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn().mockImplementation(function (this: { startThread: unknown; resumeThread: unknown }) {
    this.startThread = hoisted.startThread;
    this.resumeThread = hoisted.resumeThread;
  }),
}));

const { CodexSessionRunner } = await import('../src/executors/codexRunner.js');

async function* eventsFrom(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

function fakeThread(events: unknown[], id: string | null = 'thread-1'): FakeThread {
  return {
    id,
    runStreamed: vi.fn(async () => ({ events: eventsFrom(events) })),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-codex-runner-test-'));
}

function baseRequest(overrides: Partial<AgentSessionRequest> = {}): AgentSessionRequest {
  return {
    nodeId: 'impl',
    capabilities: capabilitySet('read', 'edit', 'exec'),
    rolePrompt: 'You implement things.',
    prompt: 'Write hello.txt',
    workingDir: tempDir(),
    ...overrides,
  };
}

const agentMessage = (text: string) => ({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
const turnCompleted = (usage: Partial<Record<string, number>> = {}) => ({
  type: 'turn.completed',
  usage: {
    input_tokens: 10,
    cached_input_tokens: 2,
    cache_write_input_tokens: 1,
    output_tokens: 5,
    reasoning_output_tokens: 3,
    ...usage,
  },
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CodexSessionRunner', () => {
  let store: RunStateStore;

  beforeEach(() => {
    store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
  });

  it('runs a turn, streams the final agent message, and reports usage', async () => {
    const thread = fakeThread([agentMessage('all done'), turnCompleted()]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    const { finalText } = await runner.run(baseRequest(), store);

    expect(finalText).toBe('all done');
    expect(store.tokensFor('impl')).toBe(10 + 2 + 1 + 5 + 3);
  });

  it('maps read-only capabilities to sandboxMode read-only', async () => {
    const thread = fakeThread([agentMessage('ok'), turnCompleted()]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    await runner.run(baseRequest({ capabilities: capabilitySet('read', 'exec') }), store);

    expect(hoisted.startThread).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'read-only' }));
  });

  it('maps edit/git-write capabilities to sandboxMode workspace-write', async () => {
    const thread = fakeThread([agentMessage('ok'), turnCompleted()]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    await runner.run(baseRequest({ capabilities: capabilitySet('read', 'edit') }), store);

    expect(hoisted.startThread).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'workspace-write' }));
  });

  it('never enables network access or web search', async () => {
    const thread = fakeThread([agentMessage('ok'), turnCompleted()]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    await runner.run(baseRequest(), store);

    expect(hoisted.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ networkAccessEnabled: false, webSearchEnabled: false, approvalPolicy: 'never' }),
    );
  });

  it('logs a command_execution item as an allowed activity entry', async () => {
    const thread = fakeThread([
      { type: 'item.started', item: { id: 'c1', type: 'command_execution' } },
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed' },
      },
      agentMessage('ran the tests'),
      turnCompleted(),
    ]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    await runner.run(baseRequest(), store);

    const activity = store.activityFor('impl');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ tool: 'run_shell', summary: 'npm test', decision: 'allowed', exitStatus: 0 });
  });

  it('throws on a turn.failed event', async () => {
    const thread = fakeThread([{ type: 'turn.failed', error: { message: 'boom' } }]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    await expect(runner.run(baseRequest(), store)).rejects.toThrow(/boom/);
  });

  it('reports the thread id via onSessionId once known', async () => {
    const thread = fakeThread([agentMessage('ok'), turnCompleted()], 'thread-42');
    hoisted.startThread.mockReturnValue(thread);
    const onSessionId = vi.fn();

    const runner = new CodexSessionRunner();
    await runner.run(baseRequest({ onSessionId }), store);

    expect(onSessionId).toHaveBeenCalledWith('thread-42');
  });

  it('throws RunInterruptedError when the signal is already aborted mid-stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const thread = fakeThread([agentMessage('ok'), turnCompleted()]);
    hoisted.startThread.mockReturnValue(thread);

    const runner = new CodexSessionRunner();
    await expect(runner.run(baseRequest({ signal: controller.signal }), store)).rejects.toThrow(RunInterruptedError);
  });

  describe('openInteractive', () => {
    it('embeds rolePrompt only on the first turn of a fresh session', async () => {
      const thread = fakeThread([agentMessage('hi'), turnCompleted()]);
      hoisted.startThread.mockReturnValue(thread);

      const runner = new CodexSessionRunner();
      const session = await runner.openInteractive(baseRequest(), store);
      await session.send('first message');
      await session.send('second message');

      const calls = (thread.runStreamed as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('You implement things.');
      expect(calls[0]![0]).toContain('first message');
      expect(calls[1]![0]).toBe('second message');
    });

    it('resumes via resumeThread and skips re-embedding rolePrompt', async () => {
      const thread = fakeThread([agentMessage('hi'), turnCompleted()]);
      hoisted.resumeThread.mockReturnValue(thread);

      const runner = new CodexSessionRunner();
      const session = await runner.openInteractive(baseRequest({ resumeSessionId: 'thread-1' }), store);
      await session.send('continuing');

      expect(hoisted.resumeThread).toHaveBeenCalledWith('thread-1', expect.any(Object));
      const calls = (thread.runStreamed as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toBe('continuing');
    });
  });
});
