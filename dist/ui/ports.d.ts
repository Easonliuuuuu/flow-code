import type { ApprovalRequest, ConvergenceRequest, InteractionPorts, TestCommandsRequest } from '../engine/types.js';
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
 * A Test node waiting to be told what to run. Mutated in place (unlike
 * `discussState`) because the App reads its fields directly on every render
 * rather than memoizing on identity.
 */
interface PendingTestCommands {
    req: TestCommandsRequest;
    resolve: (commands: string[] | null) => void;
    /** Agent proposals, once the user has asked for them. */
    proposals: Array<{
        command: string;
        rationale: string;
    }>;
    discovering: boolean;
    discoverError: string | null;
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
    pendingTestCommands: PendingTestCommands | null;
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
    testCommands: {
        request: (req: TestCommandsRequest) => Promise<string[] | null>;
    };
    /**
     * Runs the request's agent discovery and folds the proposals into the
     * pending request, so the panel can offer them alongside what the offline
     * heuristics found. Called by the App, which owns the decision to spend a
     * session on it; failures surface as `discoverError` rather than throwing
     * into a keypress handler.
     */
    discoverTestCommands(): Promise<void>;
    discuss: {
        begin: (nodeId: string, topic: string | undefined, seedTranscript?: DiscussTranscriptEntry[]) => void;
        postAssistant: (nodeId: string, text: string) => void;
        nextUserMessage: (nodeId: string) => Promise<string | null>;
        end: (nodeId: string) => void;
    };
    /** Called by the App when the user submits a discussion message (null = done). */
    submitUserMessage(text: string | null): void;
}
