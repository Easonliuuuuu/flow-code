import type { RecordedGraph } from '../runstate/types.js';
import { defaultSkillRoots, type SkillRoots } from '../skills/discover.js';
import { buildWorkflow, WorkflowValidationError, type Workflow } from './load.js';

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
