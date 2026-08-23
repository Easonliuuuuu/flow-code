import type { Notifier } from '../notify/index.js';
import { UiInteractionPorts } from '../ui/ports.js';
import { DEMO_DISCUSS_USER_MESSAGE, DEMO_REVISE_USER_MESSAGE, DEMO_STEP_DELAY_MS } from './fixtures.js';

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one scripted user turn for a given Discuss-type node id, before the conversation ends. */
function scriptedTurnFor(nodeId: string): string {
  return nodeId === 'revise' ? DEMO_REVISE_USER_MESSAGE : DEMO_DISCUSS_USER_MESSAGE;
}

/**
 * `flow-code try` needs `discuss.nextUserMessage` to answer itself instead of
 * waiting on a keypress — but `runUi`/`AppProps` require the concrete
 * `UiInteractionPorts` class, not the `InteractionPorts` interface it
 * implements: the UI reads `ports.discussState`, `ports.pendingApproval`,
 * and `ports.subscribe(...)` straight off the same instance the engine
 * drives (`App.tsx:123, 449, 470-472, 513`), not through that interface. A
 * wrapper satisfying only `InteractionPorts` cannot be handed to the UI at
 * all — its reactive state would never populate and the type would not
 * match.
 *
 * Subclassing keeps everything else identical: `approval`, `convergence`,
 * `plan`, `testCommands`, and `discuss.begin`/`postAssistant`/`end` are all
 * inherited unchanged, still mutating this same instance's reactive state
 * exactly as a live run's do — so the gate the demo pauses at is the real
 * `UiInteractionPorts` approval flow, not a re-implementation of it. Only
 * `discuss` is replaced, and only to answer `nextUserMessage` from a script
 * instead of `submitUserMessage` (`App.tsx:1526-1527`).
 */
export class DemoInteractionPorts extends UiInteractionPorts {
  // `declare`: this must not emit its own field slot. The base class already
  // owns one (set by `super()` below); a second slot here would shadow it
  // under `useDefineForClassFields` and reset `this.discuss` to `undefined`
  // the moment `super()` returns, before this constructor's own assignment
  // ever runs.
  declare discuss: UiInteractionPorts['discuss'];

  constructor(signal?: AbortSignal, notifier?: Notifier, pacingMs: number = DEMO_STEP_DELAY_MS) {
    super(signal, notifier);
    const inherited = this.discuss; // what super() just set — read before it's overwritten below
    const turnsTaken = new Map<string, number>();
    this.discuss = {
      begin: inherited.begin,
      postAssistant: inherited.postAssistant,
      end: inherited.end,
      nextUserMessage: async (nodeId: string): Promise<string | null> => {
        // Mirrors the real method's UI-visible effect (an "awaiting" state)
        // without its wait: resolved from the script rather than a keypress,
        // and — deliberately — without the real method's "Input Needed" OS
        // notification, since nothing is actually waiting on the user.
        if (this.discussState?.nodeId === nodeId) {
          this.discussState = { ...this.discussState, awaitingUser: true };
        }
        const taken = turnsTaken.get(nodeId) ?? 0;
        await delay(pacingMs);
        if (taken >= 1) return null; // one scripted turn per node, then the conversation ends
        turnsTaken.set(nodeId, taken + 1);
        return scriptedTurnFor(nodeId);
      },
    };
  }
}
