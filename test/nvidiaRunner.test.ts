import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { CompositeSessionRunner } from '../src/executors/compositeRunner.js';
import type { NvidiaMessage } from '../src/executors/nvidiaClient.js';
import { NvidiaSessionRunner } from '../src/executors/nvidiaRunner.js';
import type { AgentSessionRequest, SessionRunner } from '../src/engine/types.js';
import { RunStateStore } from '../src/runstate/store.js';
import { workflowFromYaml } from './helpers.js';

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

  it('rejects openInteractive — Discuss never routes here', async () => {
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(runner.openInteractive(baseRequest(), store)).rejects.toThrow(/does not support/);
  });

  it('throws a clear error when NVIDIA_API_KEY is unset', async () => {
    vi.unstubAllEnvs();
    const runner = new NvidiaSessionRunner();
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(runner.run(baseRequest(), store)).rejects.toThrow(/NVIDIA_API_KEY/);
  });
});

describe('CompositeSessionRunner', () => {
  it('routes discuss to the Claude runner and other agent-driven nodes to the NVIDIA runner', async () => {
    const workflow = workflowFromYaml(`
nodes:
  - id: d
    type: discuss
  - id: impl
    type: implement
    config: { instructions: x }
`);
    const calls: string[] = [];
    const claude: SessionRunner = {
      run: async () => {
        calls.push('claude.run');
        return { finalText: 'claude' };
      },
      openInteractive: async () => {
        calls.push('claude.openInteractive');
        return { send: async () => '', end: async () => {} };
      },
    };
    const nvidia: SessionRunner = {
      run: async () => {
        calls.push('nvidia.run');
        return { finalText: 'nvidia' };
      },
      openInteractive: async () => {
        throw new Error('should not be called');
      },
    };
    const composite = new CompositeSessionRunner(workflow, claude, nvidia);
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['d', 'impl'] });

    await composite.openInteractive(baseRequest({ nodeId: 'd' }), store);
    const implResult = await composite.run(baseRequest({ nodeId: 'impl' }), store);

    expect(calls).toEqual(['claude.openInteractive', 'nvidia.run']);
    expect(implResult.finalText).toBe('nvidia');
  });

  it('throws for an unknown node id', async () => {
    const workflow = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`);
    const composite = new CompositeSessionRunner(
      workflow,
      { run: async () => ({ finalText: '' }), openInteractive: async () => ({ send: async () => '', end: async () => {} }) },
      { run: async () => ({ finalText: '' }), openInteractive: async () => ({ send: async () => '', end: async () => {} }) },
    );
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['impl'] });
    await expect(composite.run(baseRequest({ nodeId: 'ghost' }), store)).rejects.toThrow(/unknown node id/);
  });
});
