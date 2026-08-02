import type { WorkflowEdge } from './schema.js';
/** A return path: when `from` fails, execution resumes at `to`. */
export interface Loopback {
    from: string;
    to: string;
    maxAttempts: number;
}
/**
 * Pure graph structure over node ids. Built after schema validation; assumes
 * every edge references a known node (checked by the loader).
 *
 * Every traversal here is over forward edges only. Loop-back edges are held
 * separately: they are return paths, not dependencies, so they must not make
 * their target wait on their source, appear in the topological order, or
 * influence layout.
 */
export declare class Graph {
    readonly nodeIds: string[];
    private readonly out;
    private readonly in_;
    private readonly loopbacks;
    constructor(nodeIds: string[], edges: WorkflowEdge[]);
    /** Loop-back edges whose source is `id` — i.e. that fire when `id` fails. */
    loopbacksFrom(id: string): Loopback[];
    allLoopbacks(): Loopback[];
    /**
     * The nodes a loop-back resets: the target, the source, and everything on a
     * forward path between them. A branch hanging off the target that does not
     * lead to the source did not feed the failure and is left alone.
     */
    nodesBetween(target: string, source: string): Set<string>;
    directDependencies(id: string): string[];
    directDependents(id: string): string[];
    /** Every node reachable downstream of `id` (transitive, excluding `id`). */
    downstreamOf(id: string): Set<string>;
    /** Every node reachable upstream of `id` (transitive, excluding `id`). */
    ancestorsOf(id: string): Set<string>;
    /**
     * Topological order. Throws with the nodes involved if the graph has a
     * cycle — callers surface this as a load-time validation error.
     */
    topologicalOrder(): string[];
}
export declare class GraphCycleError extends Error {
    readonly cycleNodes: string[];
    constructor(cycleNodes: string[]);
}
