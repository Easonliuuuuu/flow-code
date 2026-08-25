import type { RecordedGraph } from '../runstate/types.js';
import { defaultSkillRoots, type SkillRoots } from '../skills/discover.js';
import { buildWorkflow, buildWorkflowFromRaw, WorkflowValidationError, type Workflow } from './load.js';
import { spliceProposal, type PlanProposal } from './splice.js';

/**
 * Projects a loaded workflow down to what a run document can hold.
 *
 * Everything dropped here is either derived (adjacency, topological order) or
 * unserializable (a node type's zod schemas and predicates). Both are rebuilt
 * by `rehydrateGraph` from the registry the reader is running, which is the
 * point: a run records what it was told to do, not the shape of the code that
 * was doing it.
 */
export function recordGraph(workflow: Workflow, selected?: string): RecordedGraph {
  return {
    ...(selected !== undefined ? { selected } : {}),
    settings: workflow.settings,
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type.id,
      config: node.config,
      ...(node.budget ? { budget: node.budget } : {}),
    })),
    edges: workflow.edges,
  };
}

/** Thrown when a recorded graph cannot be rebuilt against the current registry. */
export class RecordedGraphError extends Error {
  constructor(readonly problems: string[]) {
    super(`cannot rebuild the graph this run recorded:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'RecordedGraphError';
  }
}

/**
 * Rebuilds a runnable workflow from what a run recorded.
 *
 * Routed through `buildWorkflow` rather than reconstructing a `Workflow` by
 * hand, so a resumed run and a fresh one agree on what a valid graph is. Skill
 * entries are re-resolved from disk for the same reason: the recorded config
 * names them, and where they live is a property of the machine, not the run.
 *
 * A recorded node naming a type this build no longer has is reported with the
 * node and the type — a run interrupted under one version and resumed under
 * another should say so, not quietly drop a step.
 */
export function rehydrateGraph(
  recorded: RecordedGraph,
  options: { repoRoot: string; skillRoots?: SkillRoots },
): Workflow {
  const skillRoots = options.skillRoots ?? defaultSkillRoots(options.repoRoot);
  try {
    return buildWorkflow(
      {
        settings: recorded.settings,
        nodes: recorded.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          ...(node.budget ? { budget: node.budget } : {}),
          config: (node.config ?? {}) as Record<string, unknown>,
        })),
        edges: recorded.edges,
      },
      { repoRoot: options.repoRoot, skillRoots },
    );
  } catch (err) {
    if (err instanceof WorkflowValidationError) throw new RecordedGraphError(err.problems);
    throw err;
  }
}

/**
 * The graph that results from splicing a Plan node's accepted proposal into
 * `workflow`, rebuilt and re-validated exactly as any other graph is —
 * defense in depth, not a re-implementation, since a caller is expected to
 * reach this only with a proposal the Plan node's own propose/validate/
 * repropose loop already accepted. Returns both the runnable `Workflow`
 * (for a fresh `Engine`) and its `RecordedGraph` projection (for
 * `RunStateStore.expandGraph`), built from the same rebuild so the two
 * cannot describe different shapes.
 *
 * The one entry point both producers reach: `driveEngine`, after the engine
 * stops with `awaiting-expansion`, and the reported path, when a guest
 * completes a Plan node. Neither splices for itself, so a proposal one accepts
 * cannot be one the other refuses.
 */
export function expandRecordedGraph(
  workflow: Workflow,
  planNodeId: string,
  proposal: PlanProposal,
  context: {
    repoRoot: string;
    skillRoots?: SkillRoots;
    /**
     * Which declared graph this run is walking, carried across the rebuild.
     * It identifies the run rather than describing its shape — the viewer's
     * header and `flow-code runs` both read it — so dropping it here would
     * leave a run that had been walking `review` walking nothing in
     * particular the moment it expanded.
     */
    selected?: string;
  },
): { workflow: Workflow; graph: RecordedGraph } {
  const skillRoots = context.skillRoots ?? defaultSkillRoots(context.repoRoot);
  const expanded = buildWorkflowFromRaw(spliceProposal(workflow, planNodeId, proposal), {
    repoRoot: context.repoRoot,
    skillRoots,
  });
  return { workflow: expanded, graph: recordGraph(expanded, context.selected) };
}
