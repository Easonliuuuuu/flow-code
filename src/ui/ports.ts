import type {
  ApprovalRequest,
  ConvergenceRequest,
  InteractionPorts,
} from '../engine/types.js';

export interface DiscussTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

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
  discussState: DiscussUiState | null = null;
  private nextMessageResolve: ((text: string | null) => void) | null = null;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  approval = {
    request: (req: ApprovalRequest): Promise<'approve' | 'reject'> =>
      new Promise((resolve) => {
        this.pendingApproval = {
          req,
          resolve: (d) => {
            this.pendingApproval = null;
            this.notify();
            resolve(d);
          },
        };
        this.notify();
      }),
  };

  convergence = {
    select: (req: ConvergenceRequest): Promise<string[]> =>
      new Promise((resolve) => {
        this.pendingConvergence = {
          req,
          resolve: (selected) => {
            this.pendingConvergence = null;
            this.notify();
            resolve(selected);
          },
        };
        this.notify();
      }),
  };

  discuss = {
    begin: (nodeId: string, topic: string | undefined): void => {
      this.discussState = { nodeId, topic, transcript: [], awaitingUser: false, active: true };
      this.notify();
    },
    postAssistant: (nodeId: string, text: string): void => {
      if (this.discussState?.nodeId === nodeId) {
        this.discussState.transcript.push({ role: 'assistant', text });
        this.notify();
      }
    },
    nextUserMessage: (nodeId: string): Promise<string | null> =>
      new Promise((resolve) => {
        if (this.discussState?.nodeId === nodeId) {
          this.discussState.awaitingUser = true;
        }
        this.nextMessageResolve = resolve;
        this.notify();
      }),
    end: (nodeId: string): void => {
      if (this.discussState?.nodeId === nodeId) {
        this.discussState.active = false;
        this.discussState.awaitingUser = false;
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
      this.discussState.awaitingUser = false;
      if (text !== null) this.discussState.transcript.push({ role: 'user', text });
    }
    this.notify();
    resolve(text);
  }
}
