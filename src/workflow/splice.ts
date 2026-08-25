import type { Workflow, WorkflowNode } from './load.js';
import type { WorkflowFileRaw } from './schema.js';

/** What a Plan node proposes: the same shape a hand-written file's `nodes`/`edges` are. */
export interface PlanProposal {
  nodes: WorkflowFileRaw['nodes'];
  edges: WorkflowFileRaw['edges'];
}

/**
 * The exact draft a user is being asked to approve, formatted for a terminal
 * conversation. Keeping this at the proposal boundary means MCP and the
 * host-agnostic CLI cannot drift into showing different plans.
 */
export function describePlanProposal(proposal: PlanProposal): string {
  const nodes = proposal.nodes.map((node) => {
    const config = node.config === undefined ? '' : ` — ${JSON.stringify(node.config)}`;
    return `- ${node.id} [${node.type}]${config}`;
  });
  const edges =
    proposal.edges.length === 0
      ? ['- (none)']
      : proposal.edges.map((edge) => {
          const qualifiers = [
            ...(edge.when === undefined ? [] : [`when: ${edge.when}`]),
            ...(edge.loopback === undefined
              ? []
              : [
                  `loopback on ${edge.loopback.on ?? 'failure'}, max ${edge.loopback.maxAttempts ?? 3} attempts`,
                ]),
          ];
          return `- ${edge.from} → ${edge.to}${qualifiers.length === 0 ? '' : ` (${qualifiers.join('; ')})`}`;
        });

  return ['Proposed graph:', 'Nodes:', ...nodes, 'Edges:', ...edges].join('\n');
}

function rawNodeOf(node: WorkflowNode): WorkflowFileRaw['nodes'][number] {
  return {
    id: node.id,
    type: node.type.id,
    ...(node.budget ? { budget: node.budget } : {}),
    config: node.config as Record<string, unknown>,
  };
}

/**
 * The raw file that results from splicing `proposal` between `planNodeId`
 * and the nodes its own outgoing forward edges point at — the shape the
 * spliced graph would be if it had been hand-written.
 *
 * A proposal node with no incoming proposal-internal edge is a root of the
 * proposal and depends on the plan node; a proposal node with no outgoing
 * proposal-internal edge is a sink of the proposal and feeds into every node
 * the plan node's own edges pointed at. This is mechanical rather than
 * semantic — it does not need to know what the proposal "means", only where
 * its own internal edges start and stop.
 *
 * Returned as a `WorkflowFileRaw` so the caller can run it through
 * `buildWorkflow` — the same validation a hand-written file gets, including
 * the git-write gate invariant — before anything is spliced for real.
 */
export function spliceProposal(
  workflow: Workflow,
  planNodeId: string,
  proposal: PlanProposal,
): WorkflowFileRaw {
  const planSuccessorIds = [
    ...new Set(
      workflow.edges.filter((e) => e.from === planNodeId && !e.loopback).map((e) => e.to),
    ),
  ];
  const keptEdges = workflow.edges.filter((e) => e.from !== planNodeId);

  const proposalToIds = new Set(proposal.edges.filter((e) => !e.loopback).map((e) => e.to));
  const proposalFromIds = new Set(proposal.edges.filter((e) => !e.loopback).map((e) => e.from));
  const proposalRoots = proposal.nodes.filter((n) => !proposalToIds.has(n.id));
  const proposalSinks = proposal.nodes.filter((n) => !proposalFromIds.has(n.id));

  const bridgeIn: WorkflowFileRaw['edges'] = proposalRoots.map((n) => ({
    from: planNodeId,
    to: n.id,
  }));
  const bridgeOut: WorkflowFileRaw['edges'] = proposalSinks.flatMap((n) =>
    planSuccessorIds.map((to) => ({ from: n.id, to })),
  );

  return {
    settings: workflow.settings,
    nodes: [...workflow.nodes.map(rawNodeOf), ...proposal.nodes],
    edges: [...keptEdges, ...proposal.edges, ...bridgeIn, ...bridgeOut],
  };
}

/**
 * `workflow` with every Plan node, and every edge touching one, removed —
 * what "keep this graph" writes back to `.flow-code/workflow.yaml`. A Plan
 * node only ever has outgoing edges (it must be a root), so removing it
 * needs no bridging the way splicing a proposal in does: its former
 * successors simply become roots of the kept graph, exactly as if the
 * negotiation had never happened and the graph had been hand-written this
 * way from the start.
 */
export function stripPlanNode(workflow: Workflow): WorkflowFileRaw {
  const planIds = new Set(
    workflow.nodes.filter((n) => n.type.id === 'plan').map((n) => n.id),
  );
  return {
    settings: workflow.settings,
    nodes: workflow.nodes.filter((n) => !planIds.has(n.id)).map(rawNodeOf),
    edges: workflow.edges.filter((e) => !planIds.has(e.from) && !planIds.has(e.to)),
  };
}
