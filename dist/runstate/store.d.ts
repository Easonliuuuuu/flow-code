import type { ActivityEntry, DiscussTranscriptEntry, NodeRunState, NodeStatus, RunBaseline, RunState, TokenUsage, WorktreeRecord } from './types.js';
export type StoreListener = (state: RunState) => void;
export interface StorePersister {
    persist(state: RunState): void;
}
/**
 * Central run-state store. The engine and harness write into it; the UI (and
 * the persister) subscribe to it. It has no dependency on the rendering
 * layer, so runs record identical state with no UI attached.
 */
export declare class RunStateStore {
    private state;
    private listeners;
    /** In-memory only: live streamed output per node, for the detail view. */
    private liveOutput;
    private persister;
    constructor(opts: {
        runId?: string;
        repoRoot: string;
        nodeIds: string[];
        /**
         * Continue a previously-interrupted run under its own runId: nodes
         * already `done` keep their recorded state; everything else resets to
         * `idle` but keeps its Discuss transcript/session id, so `--resume`
         * picks the conversation back up instead of starting blank.
         */
        resumeFrom?: RunState;
    });
    attachPersister(persister: StorePersister): void;
    get runId(): string;
    snapshot(): RunState;
    subscribe(listener: StoreListener): () => void;
    private commit;
    node(id: string): NodeRunState;
    setBaseline(baseline: RunBaseline): void;
    setStatus(nodeId: string, status: NodeStatus, detail?: string): void;
    /**
     * Accumulate token usage reported by a runner. Deltas, not totals: every
     * API response adds its own usage, so the count climbs live during a
     * session and survives across attempts (a loop-back re-run adds to the
     * node's bill rather than resetting it).
     */
    addTokens(nodeId: string, delta: Partial<TokenUsage>): void;
    /**
     * Which attempt a node is on, counting from 1. Run-state written before
     * loop-backs existed has no counter, and reads as a first attempt.
     */
    attemptOf(nodeId: string): number;
    /**
     * Return a node to `idle` for another attempt, as a loop-back does. Results
     * of the finished attempt are cleared — a stale output would otherwise look
     * like this attempt's — while its outcome is kept in `priorAttempts`. The
     * activity log is append-only and is never cleared: it is the record of what
     * actually ran, across every attempt.
     */
    resetNode(nodeId: string): void;
    setOutput(nodeId: string, output: unknown): void;
    setWorkingDir(nodeId: string, workingDir: string): void;
    /** Append an activity entry; returns it for later completion. */
    appendActivity(entry: ActivityEntry): ActivityEntry;
    /** Complete a previously appended (allowed) entry with its execution result. */
    completeActivity(toolUseId: string, result: {
        durationMs: number;
        exitStatus?: number | null;
        error?: string;
    }): void;
    activityFor(nodeId: string): ActivityEntry[];
    addWorktree(record: WorktreeRecord): void;
    updateWorktree(dir: string, patch: Partial<WorktreeRecord>): void;
    appendLiveOutput(nodeId: string, text: string): void;
    liveOutputFor(nodeId: string): string;
    appendDiscussMessage(nodeId: string, entry: DiscussTranscriptEntry): void;
    setSessionId(nodeId: string, sessionId: string): void;
    markFinished(interrupted?: boolean): void;
    allTerminal(): boolean;
}
