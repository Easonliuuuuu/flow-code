import { isRejectedGate, type NodeRunState, type RunState } from '../runstate/types.js';
import { evaluateCondition } from './condition.js';
import type { ConditionalEdge, Graph, Loopback } from './graph.js';
import type { WorkflowNode } from './load.js';
import type { LoopbackTrigger } from './schema.js';

/** A node whose outcome is settled, whether it succeeded, failed, or was skipped. */
export function routingSettled(node: NodeRunState | undefined): boolean {
  return node?.status === 'done' || node?.status === 'error' || node?.status === 'skipped';
}

/** A dependency that does not block a downstream node. */
export function dependencyCleared(node: NodeRunState | undefined): boolean {
  return node?.status === 'done' || (node?.status === 'skipped' && node.skipReason === 'condition');
}

/** Whether a parsed edge condition holds against the outputs in a run. */
export function conditionHolds(edge: ConditionalEdge, state: RunState): boolean {
  return evaluateCondition(edge.condition, state.nodes[edge.condition.nodeId]?.output);
}

/** The first incoming condition that does not hold. */
export function unmetCondition(graph: Graph, state: RunState, nodeId: string): ConditionalEdge | undefined {
  return graph.conditionsInto(nodeId).find((edge) => !conditionHolds(edge, state));
}

/**
 * The outcome that can fire a loop-back from a recorded node.
 *
 * A rejected gate is a failure trigger even when a writer records it as
 * `done`: rejection is the event that sends the run down its return path.
 */
export function loopbackTriggerFor(
  node: Pick<WorkflowNode, 'type'>,
  state: Pick<NodeRunState, 'status' | 'output'> | undefined,
): LoopbackTrigger | undefined {
  if (!state) return undefined;
  if (state.status === 'error' || (node.type.id === 'approval-gate' && isRejectedGate(state))) {
    return 'failure';
  }
  if (state.status === 'done') return 'success';
  return undefined;
}

/** Whether a loop-back's declared trigger matches the recorded source outcome. */
export function loopbackMatches(
  loopback: Loopback,
  node: Pick<WorkflowNode, 'type'>,
  state: Pick<NodeRunState, 'status' | 'output'> | undefined,
): boolean {
  return loopbackTriggerFor(node, state) === loopback.on;
}

/**
 * A reported run records rejected gates as `error`, while its conditional
 * branch still needs that gate to be a usable dependency on the rejected arm.
 */
export function reportedDependencyCleared(
  graph: Graph,
  state: RunState,
  targetId: string,
  dependencyId: string,
): boolean {
  const dependency = state.nodes[dependencyId];
  if (isRejectedGate(dependency)) {
    const edge = graph.conditionsInto(targetId).find((candidate) => candidate.from === dependencyId);
    return edge !== undefined && conditionHolds(edge, state);
  }
  return dependencyCleared(dependency);
}
