export declare const NODE_STATUSES: readonly ["idle", "running", "waiting", "done", "error", "skipped"];
export type NodeStatus = (typeof NODE_STATUSES)[number];
/**
 * One row of a node's tool-call activity log. Appended from the harness
 * interception point (never from the UI), so headless runs record it too.
 */
export interface ActivityEntry {
    ts: string;
    nodeId: string;
    /** Distinguishes worktree instances within one node. */
    instanceId?: string;
    tool: string;
    /** The command string or a short input summary. */
    summary: string;
    decision: 'allowed' | 'denied';
    /** Set on denials: which capability the node type lacks. */
    missingCapability?: string;
    /** Set once an allowed call finishes. */
    durationMs?: number;
    exitStatus?: number | null;
    error?: string;
    toolUseId?: string;
}
export interface WorktreeRecord {
    nodeId: string;
    instanceId: string;
    branch: string;
    dir: string;
    removed: boolean;
    converged: boolean;
}
export interface RunBaseline {
    /** Commit sha at run start. */
    commit: string;
    /**
     * Tree sha every diff in the run is computed against. Equals the commit's
     * tree on a clean start; under the dirty-tree override it is a snapshot of
     * the working tree as it existed at run start.
     */
    tree: string;
    dirtyOverride: boolean;
}
export interface DiscussTranscriptEntry {
    role: 'user' | 'assistant';
    text: string;
}
/** The terminal outcome of one attempt, kept when a loop-back resets a node. */
export interface AttemptRecord {
    status: NodeStatus;
    detail?: string;
    endedAt: string;
}
/**
 * Tokens a node has consumed so far, accumulated across every API call it
 * makes (and, for a fan-out node, across all of its instances). Absent on
 * node types with no agent session — they cost nothing.
 */
export interface TokenUsage {
    /** Fresh (uncached) prompt tokens. */
    input: number;
    output: number;
    /** Prompt tokens served from, or written to, the provider's cache. */
    cached: number;
}
/** Every token a usage record accounts for — what a budget is measured against. */
export declare function sumTokens(usage: TokenUsage | undefined): number;
export interface NodeRunState {
    status: NodeStatus;
    statusDetail?: string;
    output?: unknown;
    /** Set the first time the node enters `running`; cleared by a loop-back reset. */
    startedAt?: string;
    /** Set when the node reaches a terminal status; cleared by a loop-back reset. */
    endedAt?: string;
    /** Cumulative across attempts: what this node has cost, not what this attempt cost. */
    tokens?: TokenUsage;
    /**
     * Why a `skipped` node was skipped, which decides what it means downstream:
     *  - `condition`: a routing condition sent the run down another branch. The
     *    branch was not taken, so it does not block a node that also has a live
     *    path into it (the two arms of a diamond rejoining at a gate).
     *  - `upstream`: something above it failed or never completed. That *does*
     *    block everything below, exactly as it always has.
     */
    skipReason?: 'condition' | 'upstream';
    /**
     * Which attempt this node is on, counting from 1. Greater than 1 only when
     * a loop-back has reset and re-run it.
     */
    attempt?: number;
    /** Terminal outcome of each earlier attempt, oldest first. */
    priorAttempts?: AttemptRecord[];
    /** Count of denied tool calls, for the blocked-action indicator. */
    denials: number;
    workingDir?: string;
    /** Persisted Discuss transcript, so an interrupted conversation survives to `--resume`. */
    discussTranscript?: DiscussTranscriptEntry[];
    /** Underlying agent session id, so `--resume` can continue it with full context. */
    sessionId?: string;
    /**
     * Ids of the skills this node ran with, so its behavior can be attributed to
     * the instructions it was actually given rather than to its node type alone.
     */
    skills?: string[];
}
export interface RunState {
    runId: string;
    createdAt: string;
    repoRoot: string;
    pid: number;
    baseline: RunBaseline | null;
    nodes: Record<string, NodeRunState>;
    worktrees: WorktreeRecord[];
    activity: ActivityEntry[];
    finishedAt?: string;
    /** True when the run ended via ctrl+c/SIGTERM rather than completing on its own; `--resume` looks for this. */
    interrupted?: boolean;
}
