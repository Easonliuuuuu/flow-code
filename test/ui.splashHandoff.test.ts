import { describe, expect, it, vi } from 'vitest';
import type { RunStateStore } from '../src/runstate/store.js';
import type { ModelContext } from '../src/ui/App.js';
import type { UiInteractionPorts } from '../src/ui/ports.js';
import type { Workflow } from '../src/workflow/load.js';

/**
 * The splash and the graph are two separate Ink instances sharing one
 * `process.stdin`, and Ink defers the terminal half of its raw-mode teardown
 * to a `queueMicrotask` guarded by a ref private to each instance
 * (`pendingDisableRawModeRef` in ink/components/App.js). Neither instance can
 * see the other's pending teardown, so mounting the graph synchronously from
 * the splash's `onDone` let the graph's `stdin.setRawMode(true)` land first
 * and the splash's queued `setRawMode(false)` + `stdin.unref()` land second —
 * leaving the whole UI mounted over a cooked-mode tty. Symptom in a real
 * terminal: every keystroke echoed by the terminal instead of reaching Ink,
 * the mouse-tracking sequences the graph just enabled echoed as garbage
 * alongside them, no key doing anything, and only a real SIGINT able to quit.
 *
 * The invariant that avoids it is timing-only and invisible in a rendered
 * frame, so it is pinned here directly: the graph must not be mounted in the
 * same tick the splash finishes. A macrotask boundary is what guarantees the
 * microtask queue — and therefore the splash's teardown — has fully drained.
 */

type FakeElement = { type: unknown; props: Record<string, unknown> };

const hoisted = vi.hoisted(() => ({ rendered: [] as FakeElement[] }));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: (element: FakeElement) => {
      hoisted.rendered.push(element);
      return {
        unmount: vi.fn(),
        rerender: vi.fn(),
        clear: vi.fn(),
        cleanup: vi.fn(),
        waitUntilExit: () => new Promise<void>(() => {}),
      };
    },
  };
});

const { runUi } = await import('../src/ui/index.js');
const { Splash } = await import('../src/ui/splash.js');
const { App } = await import('../src/ui/App.js');

/** `runUi`'s arguments are all forwarded straight to `App`, which never renders here. */
function startUi(): Promise<void> {
  return runUi({
    workflow: { order: [], nodes: {} } as unknown as Workflow,
    store: {} as unknown as RunStateStore,
    ports: {} as unknown as UiInteractionPorts,
    modelContext: {} as unknown as ModelContext,
    onInterrupt: () => {},
  });
}

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('splash → App handoff', () => {
  it('defers mounting App past the splash instance’s pending raw-mode teardown', async () => {
    hoisted.rendered.length = 0;
    const done = startUi();

    expect(hoisted.rendered).toHaveLength(1);
    expect(hoisted.rendered[0]?.type).toBe(Splash);

    (hoisted.rendered[0]?.props['onDone'] as () => void)();

    // The point of the test: still just the splash. Draining only microtasks
    // must not be enough to bring App up either, since that is exactly the
    // queue the splash's teardown is sitting in.
    expect(hoisted.rendered).toHaveLength(1);
    await Promise.resolve();
    expect(hoisted.rendered).toHaveLength(1);

    await nextMacrotask();
    expect(hoisted.rendered).toHaveLength(2);
    expect(hoisted.rendered[1]?.type).toBe(App);

    // Releases runUi's keep-alive interval so the suite doesn't hold a timer.
    (hoisted.rendered[1]?.props['onExit'] as () => void)();
    await done;
  });

  it('mounts App immediately when the splash is opted out, with no handoff to sequence', async () => {
    hoisted.rendered.length = 0;
    const done = runUi({
      workflow: { order: [], nodes: {} } as unknown as Workflow,
      store: {} as unknown as RunStateStore,
      ports: {} as unknown as UiInteractionPorts,
      modelContext: {} as unknown as ModelContext,
      onInterrupt: () => {},
      splash: false,
    });

    expect(hoisted.rendered).toHaveLength(1);
    expect(hoisted.rendered[0]?.type).toBe(App);

    (hoisted.rendered[0]?.props['onExit'] as () => void)();
    await done;
  });
});
