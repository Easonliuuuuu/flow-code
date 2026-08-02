import type { NodeTypeId } from '../registry/index.js';
import type { RunStateStore } from '../runstate/store.js';
import type { RunBaseline } from '../runstate/types.js';
import type { Workflow } from '../workflow/load.js';
import type { InteractionPorts, NodeExecutor, SessionRunner } from './types.js';
/** Above this, an upstream output is injected truncated (full value stays in run-state). */
export declare const UPSTREAM_OUTPUT_LIMIT: number;
export declare const TRUNCATION_MARKER = "\u2026[truncated by flow-code: full output in run-state]";
export interface EngineOptions {
    workflow: Workflow;
    store: RunStateStore;
    repoRoot: string;
    baseline: RunBaseline;
    ports: InteractionPorts;
    sessions: SessionRunner;
    executors: Record<NodeTypeId, NodeExecutor>;
    /** Aborted to interrupt the run (e.g. ctrl+c); defaults to a signal that never fires. */
    signal?: AbortSignal;
}
/**
 * DAG executor. Starts nodes when their dependencies are satisfied, but
 * serializes every node that operates on the shared main working tree —
 * true concurrency exists only between Worktree-Agent instances (which the
 * worktree executor runs under the session-slot semaphore).
 */
export declare class Engine {
    private readonly wf;
    private readonly store;
    private readonly opts;
    private readonly sessionSlots;
    private readonly signal;
    private mainTreeLockHolder;
    private readonly running;
    /** Pending "why you are running again" context, keyed by loop-back target. */
    private readonly retryReasons;
    constructor(opts: EngineOptions);
    private nodeById;
    /** Worktree-Agent orchestrates isolated dirs; the gate only waits and reads. */
    private takesMainTreeLock;
    private discussActive;
    private depsSatisfied;
    /**
     * The dependency ids whose outputs a starting node receives: its direct
     * dependencies, plus — through any dependency whose type is
     * context-transparent — that dependency's own dependencies. Fan-in still
     * bounds context growth; transparency only prevents a node that records a
     * decision rather than a result (an Approval-Gate) from severing the chain.
     *
     * Older context is collected first, and each node id appears once however
     * many paths reach it.
     */
    private upstreamNodeIds;
    /**
     * Recorded outputs injected into a starting node's context, sharing one
     * overall size budget so that forwarding through a transparent node cannot
     * grow context without bound. Every dependency is still present; an entry
     * that does not fit is truncated and marked.
     */
    private upstreamInputs;
    /**
     * A node downstream of a Worktree-Agent convergence runs in the converged
     * working directory, not the repository's main checkout.
     */
    private workingDirFor;
    /**
     * Evaluate a node type's declared failure predicate against its recorded
     * output, returning the status detail when the node has failed on its own
     * result. The predicate only ever sees output already validated against the
     * type's output schema.
     */
    private outputFailureDetail;
    /**
     * Capture why a loop-back fired, so the retried segment learns something the
     * first pass did not know. Without this the re-run is identical to the run
     * that just failed, and the loop is pure cost.
     */
    private recordRetryReason;
    /**
     * A failed node routes back to an upstream node when a loop-back declares it
     * as its source. Resets that target, the source, and everything on a forward
     * path between them, so the scheduler re-runs the segment. Returns false when
     * no loop-back applies — the caller then skips downstream as before.
     */
    private fireLoopback;
    private markDownstreamSkipped;
    private runNode;
    private startEligible;
    run(): Promise<void>;
}
