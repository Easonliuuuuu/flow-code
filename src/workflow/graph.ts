import { parseCondition, type Condition } from './condition.js';
import type { LoopbackTrigger, WorkflowEdge } from './schema.js';

/** A return path: when `from` ends the way `on` names, execution resumes at `to`. */
export interface Loopback {
  from: string;
  to: string;
  maxAttempts: number;
  on: LoopbackTrigger;
}

/** A forward edge that only carries when its condition holds. */
export interface ConditionalEdge {
  from: string;
  to: string;
  condition: Condition;
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
export class Graph {
  readonly nodeIds: string[];
  private readonly out = new Map<string, string[]>();
  private readonly in_ = new Map<string, string[]>();
  private readonly loopbacks: Loopback[] = [];
  private readonly conditionals: ConditionalEdge[] = [];

  constructor(nodeIds: string[], edges: WorkflowEdge[]) {
    this.nodeIds = nodeIds;
    for (const id of nodeIds) {
      this.out.set(id, []);
      this.in_.set(id, []);
    }
    for (const e of edges) {
      if (e.loopback) {
        this.loopbacks.push({
          from: e.from,
          to: e.to,
          maxAttempts: e.loopback.maxAttempts,
          on: e.loopback.on,
        });
        continue;
      }
      this.out.get(e.from)!.push(e.to);
      this.in_.get(e.to)!.push(e.from);
      // A conditional edge is a dependency like any other — the target still
      // waits for the source. The condition decides whether reaching that
      // point means "run" or "skip", never whether to wait.
      if (e.when !== undefined) {
        this.conditionals.push({ from: e.from, to: e.to, condition: parseCondition(e.when) });
      }
    }
  }

  /** Conditions guarding entry to `id` — all must hold for it to run. */
  conditionsInto(id: string): ConditionalEdge[] {
    return this.conditionals.filter((c) => c.to === id);
  }

  allConditionals(): ConditionalEdge[] {
    return [...this.conditionals];
  }

  /** Loop-back edges whose source is `id` — i.e. that fire when `id` fails. */
  loopbacksFrom(id: string): Loopback[] {
    return this.loopbacks.filter((l) => l.from === id);
  }

  allLoopbacks(): Loopback[] {
    return [...this.loopbacks];
  }

  /**
   * The nodes a loop-back resets: the target, the source, and everything on a
   * forward path between them. A branch hanging off the target that does not
   * lead to the source did not feed the failure and is left alone.
   */
  nodesBetween(target: string, source: string): Set<string> {
    const between = new Set([target, source]);
    const descendants = this.downstreamOf(target);
    for (const id of this.ancestorsOf(source)) {
      if (descendants.has(id)) between.add(id);
    }
    return between;
  }

  directDependencies(id: string): string[] {
    return this.in_.get(id) ?? [];
  }

  directDependents(id: string): string[] {
    return this.out.get(id) ?? [];
  }

  /** Every node reachable downstream of `id` (transitive, excluding `id`). */
  downstreamOf(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...(this.out.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(this.out.get(next) ?? []));
    }
    return seen;
  }

  /** Every node reachable upstream of `id` (transitive, excluding `id`). */
  ancestorsOf(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...(this.in_.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(this.in_.get(next) ?? []));
    }
    return seen;
  }

  /**
   * Topological order. Throws with the nodes involved if the graph has a
   * cycle — callers surface this as a load-time validation error.
   */
  topologicalOrder(): string[] {
    const indegree = new Map<string, number>();
    for (const id of this.nodeIds) indegree.set(id, this.in_.get(id)!.length);
    const queue = this.nodeIds.filter((id) => indegree.get(id) === 0);
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const dep of this.out.get(id)!) {
        const d = indegree.get(dep)! - 1;
        indegree.set(dep, d);
        if (d === 0) queue.push(dep);
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
  constructor(readonly cycleNodes: string[]) {
    super(`workflow graph contains a cycle involving: ${cycleNodes.join(', ')}`);
    this.name = 'GraphCycleError';
  }
}
