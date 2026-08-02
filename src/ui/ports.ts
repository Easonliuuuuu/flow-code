import type {
  ApprovalRequest,
  ConvergenceRequest,
  InteractionPorts,
} from '../engine/types.js';
import { RunInterruptedError } from '../engine/types.js';
import type { DiscussTranscriptEntry } from '../runstate/types.js';

export type { DiscussTranscriptEntry } from '../runstate/types.js';

export interface DiscussUiState {
  nodeId: string;
  topic: string | undefined;
  transcript: DiscussTranscriptEntry[];
  /** True while the executor is waiting for the user's next message. */
  awaitingUser: boolean;
  active: boolean;
}

interface PendingApproval {
  req: ApprovalRequest;
  resolve: (decision: 'approve' | 'reject') => void;
}

interface PendingConvergence {
  req: ConvergenceRequest;
  resolve: (selected: string[]) => void;
}

/**
 * The UI side of the engine's interaction ports: executors block on promises
 * that the App resolves from key presses. The engine never imports this —
 * headless runs substitute any other InteractionPorts implementation.
 */
export class UiInteractionPorts implements InteractionPorts {
  pendingApproval: PendingApproval | null = null;
  pendingConvergence: PendingConvergence | null = null;
  /**
   * Replaced wholesale on every change (never mutated in place): the App
   * memoizes the rendered transcript on this object's identity, so an
   * in-place push would leave new messages invisible on screen.
   */
  discussState: DiscussUiState | null = null;
  private nextMessageResolve: ((text: string | null) => void) | null = null;
  private listeners = new Set<() => void>();

  /** Aborted when the run is interrupted (e.g. ctrl+c); rejects any pending wait on the user. */
  constructor(private readonly signal?: AbortSignal) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /** Rejects `reject` (and runs `onAbort`) the moment the run is interrupted. */
  private onInterrupt(reject: (err: unknown) => void, onAbort: () => void): void {
    if (!this.signal) return;
    const fire = (): void => {
      onAbort();
      this.notify();
      reject(new RunInterruptedError());
    };
    if (this.signal.aborted) {
      // Queue as a microtask: callers attach this after constructing the
      // Promise, so resolve/reject must not fire synchronously inline.
      void Promise.resolve().then(fire);
      return;
    }
    this.signal.addEventListener('abort', fire, { once: true });
  }

  approval = {
    request: (req: ApprovalRequest): Promise<'approve' | 'reject'> =>
      new Promise((resolve, reject) => {
        this.pendingApproval = {
          req,
          resolve: (d) => {
            this.pendingApproval = null;
            this.notify();
            resolve(d);
          },
        };
        this.notify();
        this.onInterrupt(reject, () => {
          this.pendingApproval = null;
        });
      }),
  };

  convergence = {
    select: (req: ConvergenceRequest): Promise<string[]> =>
      new Promise((resolve, reject) => {
        this.pendingConvergence = {
          req,
          resolve: (selected) => {
            this.pendingConvergence = null;
            this.notify();
            resolve(selected);
          },
        };
        this.notify();
        this.onInterrupt(reject, () => {
          this.pendingConvergence = null;
        });
      }),
  };

  discuss = {
    begin: (
      nodeId: string,
      topic: string | undefined,
      seedTranscript: DiscussTranscriptEntry[] = [],
    ): void => {
      this.discussState = {
        nodeId,
        topic,
        transcript: [...seedTranscript],
        awaitingUser: false,
        active: true,
      };
      this.notify();
    },
    postAssistant: (nodeId: string, text: string): void => {
      if (this.discussState?.nodeId === nodeId) {
        this.discussState = {
          ...this.discussState,
          transcript: [...this.discussState.transcript, { role: 'assistant', text }],
        };
        this.notify();
      }
    },
    nextUserMessage: (nodeId: string): Promise<string | null> =>
      new Promise((resolve, reject) => {
        if (this.discussState?.nodeId === nodeId) {
          this.discussState = { ...this.discussState, awaitingUser: true };
        }
        this.nextMessageResolve = resolve;
        this.notify();
        this.onInterrupt(reject, () => {
          this.nextMessageResolve = null;
        });
      }),
    end: (nodeId: string): void => {
      if (this.discussState?.nodeId === nodeId) {
        this.discussState = { ...this.discussState, active: false, awaitingUser: false };
        this.notify();
      }
    },
  };

  /** Called by the App when the user submits a discussion message (null = done). */
  submitUserMessage(text: string | null): void {
    const resolve = this.nextMessageResolve;
    if (!resolve) return;
    this.nextMessageResolve = null;
    if (this.discussState) {
      this.discussState = {
        ...this.discussState,
        awaitingUser: false,
        transcript:
          text === null
            ? this.discussState.transcript
            : [...this.discussState.transcript, { role: 'user', text }],
      };
    }
    this.notify();
    resolve(text);
  }
}
