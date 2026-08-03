import { parseCondition } from './condition.js';
/**
 * Pure graph structure over node ids. Built after schema validation; assumes
 * every edge references a known node (checked by the loader).
 *
 * Every traversal here is over forward edges only. Loop-back edges are held
 * separately: they are return paths, not dependencies, so they must not make
 * their target wait on their source, appear in the topological order, or
 * influence layout.
 */
export class Graph {
    nodeIds;
    out = new Map();
    in_ = new Map();
    loopbacks = [];
    conditionals = [];
    constructor(nodeIds, edges) {
        this.nodeIds = nodeIds;
        for (const id of nodeIds) {
            this.out.set(id, []);
            this.in_.set(id, []);
        }
        for (const e of edges) {
            if (e.loopback) {
                this.loopbacks.push({ from: e.from, to: e.to, maxAttempts: e.loopback.maxAttempts });
                continue;
            }
            this.out.get(e.from).push(e.to);
            this.in_.get(e.to).push(e.from);
            // A conditional edge is a dependency like any other — the target still
            // waits for the source. The condition decides whether reaching that
            // point means "run" or "skip", never whether to wait.
            if (e.when !== undefined) {
                this.conditionals.push({ from: e.from, to: e.to, condition: parseCondition(e.when) });
            }
        }
    }
    /** Conditions guarding entry to `id` — all must hold for it to run. */
    conditionsInto(id) {
        return this.conditionals.filter((c) => c.to === id);
    }
    allConditionals() {
        return [...this.conditionals];
    }
    /** Loop-back edges whose source is `id` — i.e. that fire when `id` fails. */
    loopbacksFrom(id) {
        return this.loopbacks.filter((l) => l.from === id);
    }
    allLoopbacks() {
        return [...this.loopbacks];
    }
    /**
     * The nodes a loop-back resets: the target, the source, and everything on a
     * forward path between them. A branch hanging off the target that does not
     * lead to the source did not feed the failure and is left alone.
     */
    nodesBetween(target, source) {
        const between = new Set([target, source]);
        const descendants = this.downstreamOf(target);
        for (const id of this.ancestorsOf(source)) {
            if (descendants.has(id))
                between.add(id);
        }
        return between;
    }
    directDependencies(id) {
        return this.in_.get(id) ?? [];
    }
    directDependents(id) {
        return this.out.get(id) ?? [];
    }
    /** Every node reachable downstream of `id` (transitive, excluding `id`). */
    downstreamOf(id) {
        const seen = new Set();
        const stack = [...(this.out.get(id) ?? [])];
        while (stack.length > 0) {
            const next = stack.pop();
            if (seen.has(next))
                continue;
            seen.add(next);
            stack.push(...(this.out.get(next) ?? []));
        }
        return seen;
    }
    /** Every node reachable upstream of `id` (transitive, excluding `id`). */
    ancestorsOf(id) {
        const seen = new Set();
        const stack = [...(this.in_.get(id) ?? [])];
        while (stack.length > 0) {
            const next = stack.pop();
            if (seen.has(next))
                continue;
            seen.add(next);
            stack.push(...(this.in_.get(next) ?? []));
        }
        return seen;
    }
    /**
     * Topological order. Throws with the nodes involved if the graph has a
     * cycle — callers surface this as a load-time validation error.
     */
    topologicalOrder() {
        const indegree = new Map();
        for (const id of this.nodeIds)
            indegree.set(id, this.in_.get(id).length);
        const queue = this.nodeIds.filter((id) => indegree.get(id) === 0);
        const order = [];
        while (queue.length > 0) {
            const id = queue.shift();
            order.push(id);
            for (const dep of this.out.get(id)) {
                const d = indegree.get(dep) - 1;
                indegree.set(dep, d);
                if (d === 0)
                    queue.push(dep);
            }
        }
        if (order.length !== this.nodeIds.length) {
            const cycleNodes = this.nodeIds.filter((id) => !order.includes(id));
            throw new GraphCycleError(cycleNodes);
        }
        return order;
    }
}
export class GraphCycleError extends Error {
    cycleNodes;
    constructor(cycleNodes) {
        super(`workflow graph contains a cycle involving: ${cycleNodes.join(', ')}`);
        this.cycleNodes = cycleNodes;
        this.name = 'GraphCycleError';
    }
}
//# sourceMappingURL=graph.js.map