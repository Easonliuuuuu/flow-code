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
    /**
     * One abort controller per in-flight node, so a per-node budget can stop
     * that node's session without taking down the rest of the run. Each is
     * chained to the run-wide signal, so ctrl+c still stops everything.
     */
    private readonly nodeAborts;
    /** Nodes stopped by their own budget, with the message explaining it. */
    private readonly nodeBudgetStops;
    /** Set once a run-wide budget is spent; no further node ever starts. */
    private runBudgetStop;
    private runStartedAt;
    constructor(opts: EngineOptions);
    /**
     * Enforce the run's stop rules. Called on every run-state change (token
     * counts move there) and on a timer while a wall-clock budget is set.
     *
     * A run-wide breach stops everything; a per-node breach stops only the node
     * that overspent, so the rest of the graph can still finish and report. In
     * both cases the stop is an abort of a live session, not a polite request:
     * the point of a ceiling is that it holds.
     */
    private checkBudgets;
    private stopRun;
    private nodeById;
    /** Worktree-Agent orchestrates isolated dirs; the gate only waits and reads. */
    private takesMainTreeLock;
    private discussActive;
    /**
     * A dependency stops holding a node back once it is `done` — or once it was
     * skipped because a routing condition took the run down a different branch.
     * A branch that was never taken is not a failure and must not block the
     * node the branches rejoin at; a branch that *failed* still does.
     */
    private depCleared;
    private depsSatisfied;
    /**
     * True when every path into a node came from a branch that was not taken —
     * nothing upstream of it actually ran, so there is nothing for it to do.
     * This is what makes a skip cascade down its own arm of the graph while a
     * node with a live path into it still runs.
     */
    private onlyUntakenBranchesInto;
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
    /**
     * The first incoming condition that does not hold, once every dependency is
     * done. All of them must hold for a node to run — a conditional edge is a
     * dependency that also has an opinion, and an unmet opinion means this
     * branch is not the one being taken.
     */
    private unmetCondition;
    private runNode;
    private startEligible;
    run(): Promise<void>;
}
