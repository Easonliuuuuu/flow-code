import type { ApprovalRequest, ConvergenceRequest, InteractionPorts } from '../engine/types.js';
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
export declare class UiInteractionPorts implements InteractionPorts {
    private readonly signal?;
    pendingApproval: PendingApproval | null;
    pendingConvergence: PendingConvergence | null;
    /**
     * Replaced wholesale on every change (never mutated in place): the App
     * memoizes the rendered transcript on this object's identity, so an
     * in-place push would leave new messages invisible on screen.
     */
    discussState: DiscussUiState | null;
    private nextMessageResolve;
    private listeners;
    /** Aborted when the run is interrupted (e.g. ctrl+c); rejects any pending wait on the user. */
    constructor(signal?: AbortSignal | undefined);
    subscribe(listener: () => void): () => void;
    private notify;
    /** Rejects `reject` (and runs `onAbort`) the moment the run is interrupted. */
    private onInterrupt;
    approval: {
        request: (req: ApprovalRequest) => Promise<"approve" | "reject">;
    };
    convergence: {
        select: (req: ConvergenceRequest) => Promise<string[]>;
    };
    discuss: {
        begin: (nodeId: string, topic: string | undefined, seedTranscript?: DiscussTranscriptEntry[]) => void;
        postAssistant: (nodeId: string, text: string) => void;
        nextUserMessage: (nodeId: string) => Promise<string | null>;
        end: (nodeId: string) => void;
    };
    /** Called by the App when the user submits a discussion message (null = done). */
    submitUserMessage(text: string | null): void;
}
