import { describe, expect, it, vi } from 'vitest';
import { capabilitySet } from '../src/capabilities.js';
import { SubagentScope, type SlotPool } from '../src/engine/slots.js';
import { createInterceptor } from '../src/harness/intercept.js';
import { RunStateStore } from '../src/runstate/store.js';

/** A pool of `capacity` slots, with the non-blocking semantics the real one has. */
function pool(capacity: number): SlotPool & { free: () => number } {
  let available = capacity;
  return {
    tryAcquire: () =>
      available > 0
        ? (available--,
          () => {
            available++;
          })
        : null,
    free: () => available,
  };
}

function interceptorWith(scope: SubagentScope) {
  const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['n1'] });
  const interceptor = createInterceptor({
    nodeId: 'n1',
    capabilities: capabilitySet('read', 'edit', 'exec'),
    workingDir: '/repo',
    store,
    subagentTypes: new Set(['worker']),
    subagentSlots: scope,
  });
  return { interceptor, store };
}

describe('subagent concurrency', () => {
  it('refuses a spawn once the cap is spent, rather than making it wait', () => {
    const slots = pool(2);
    const scope = new SubagentScope(slots);
    const { interceptor, store } = interceptorWith(scope);

    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('allow');
    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('allow');
    const third = interceptor.check('Agent', { subagent_type: 'worker' });

    expect(third.behavior).toBe('deny');
    expect(third.message).toContain('concurrency cap');
    const denied = store.activityFor('n1').filter((e) => e.decision === 'denied');
    expect(denied[0]!.missingCapability).toBe('concurrency');
  });

  it('claims the slot at permission time, so a burst cannot overshoot', () => {
    // Several spawns can clear the check before any of them reports starting,
    // so the check has to be self-consistent rather than trusting SubagentStart.
    const slots = pool(2);
    const scope = new SubagentScope(slots);
    const { interceptor } = interceptorWith(scope);

    interceptor.check('Agent', { subagent_type: 'worker' });
    interceptor.check('Agent', { subagent_type: 'worker' });
    expect(slots.free()).toBe(0);
    expect(scope.held).toBe(2);
  });

  it('returns the allowance when a subagent finishes', () => {
    const slots = pool(1);
    const scope = new SubagentScope(slots);
    const { interceptor } = interceptorWith(scope);

    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('allow');
    scope.started('a1');
    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('deny');

    scope.stopped('a1');
    expect(slots.free()).toBe(1);
    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('allow');
  });

  it('never blocks, so a parent holding a slot cannot deadlock on its child', () => {
    // The whole reason spawns are refused rather than queued: the session that
    // spawns holds a slot while it waits, so a queued child would be waiting on
    // a slot its own parent owns.
    const slots = pool(1);
    const parentSlot = slots.tryAcquire();
    expect(parentSlot).not.toBeNull();

    const scope = new SubagentScope(slots);
    const { interceptor } = interceptorWith(scope);
    // Returns a decision synchronously rather than returning a promise to await.
    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('deny');
  });

  it('returns a slot claimed by a spawn that never started', () => {
    const slots = pool(2);
    const scope = new SubagentScope(slots);
    const { interceptor } = interceptorWith(scope);

    interceptor.check('Agent', { subagent_type: 'worker' });
    interceptor.check('Agent', { subagent_type: 'worker' });
    scope.started('a1');
    scope.stopped('a1');
    // One spawn was allowed but never reported starting; ending the session
    // must not strand its slot for the rest of the run.
    scope.dispose();

    expect(slots.free()).toBe(2);
    expect(scope.held).toBe(0);
  });

  it('is safe to dispose twice', () => {
    const slots = pool(2);
    const scope = new SubagentScope(slots);
    const { interceptor } = interceptorWith(scope);
    interceptor.check('Agent', { subagent_type: 'worker' });

    scope.dispose();
    scope.dispose();
    expect(slots.free()).toBe(2);
  });

  it('refuses every spawn when there is no pool at all', () => {
    const scope = new SubagentScope(undefined);
    const { interceptor } = interceptorWith(scope);
    expect(interceptor.check('Agent', { subagent_type: 'worker' }).behavior).toBe('deny');
  });

  it('does not spend a slot on a spawn refused for its type', () => {
    const slots = pool(1);
    const scope = new SubagentScope(slots);
    const { interceptor } = interceptorWith(scope);

    expect(interceptor.check('Agent', { subagent_type: 'general-purpose' }).behavior).toBe('deny');
    expect(slots.free()).toBe(1);
  });
});

describe('subagent output integrity', () => {
  it('keeps a subagent turn out of the node result', async () => {
    // Observed in the live SDK with forwardSubagentText unset: a subagent's
    // assistant messages do reach the stream. Letting one through would
    // overwrite the verdict a Validate node routes on.
    const messages = [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 's1',
        message: { content: [{ type: 'text', text: '{"verdict":"pass","notes":"ok"}' }], usage: {} },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'I looked at three files and found nothing.' }], usage: {} },
      },
    ];

    const hoisted = vi.hoisted(() => ({ query: vi.fn() }));
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: hoisted.query }));
    hoisted.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
    });

    const { SdkSessionRunner } = await import('../src/executors/sdkRunner.js');
    const store = new RunStateStore({ repoRoot: '/repo', nodeIds: ['n1'] });
    const { finalText } = await new SdkSessionRunner().run(
      {
        nodeId: 'n1',
        capabilities: capabilitySet('read'),
        rolePrompt: 'r',
        prompt: 'p',
        workingDir: '/repo',
      },
      store,
    );

    expect(finalText).toBe('{"verdict":"pass","notes":"ok"}');
    expect(finalText).not.toContain('three files');
    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  });
});
