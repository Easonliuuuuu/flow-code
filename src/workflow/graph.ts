import type { WorkflowEdge } from './schema.js';

/**
 * Pure graph structure over node ids. Built after schema validation; assumes
 * every edge references a known node (checked by the loader).
 */
export class Graph {
  readonly nodeIds: string[];
  private readonly out = new Map<string, string[]>();
  private readonly in_ = new Map<string, string[]>();

  constructor(nodeIds: string[], edges: WorkflowEdge[]) {
    this.nodeIds = nodeIds;
    for (const id of nodeIds) {
      this.out.set(id, []);
      this.in_.set(id, []);
    }
    for (const e of edges) {
      this.out.get(e.from)!.push(e.to);
      this.in_.get(e.to)!.push(e.from);
    }
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
