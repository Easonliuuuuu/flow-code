import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getNodeType, TEST_COMMANDS_AUTO, type NodeTypeDefinition } from '../registry/index.js';
import {
  defaultSkillRoots,
  discoverSkills,
  resolveSkillEntry,
  type DiscoveredSkill,
  type SkillRoots,
} from '../skills/discover.js';
import { parseCondition } from './condition.js';
import { Graph, GraphCycleError } from './graph.js';
import {
  DEFAULT_SETTINGS,
  workflowFileSchema,
  type NodeBudget,
  type RunSettings,
  type WorkflowEdge,
  type WorkflowFileRaw,
} from './schema.js';

export const WORKFLOW_RELATIVE_PATH = '.flow-code/workflow.yaml';

export interface WorkflowNode {
  id: string;
  type: NodeTypeDefinition;
  /** Config validated against the type's schema (defaults applied). */
  config: unknown;
  /** This node's own ceiling, overriding the run-wide per-node one. */
  budget?: NodeBudget;
  /**
   * Skills named in `config.skills`, resolved at load time in declaration
   * order. Resolution happens here, once, so an unresolvable skill is a
   * validation error before the run starts rather than a failure raised when
   * the node executes.
   */
  skills: DiscoveredSkill[];
}

export interface LoadOptions {
  /** Anchors repo-relative skill paths and the project skill root. */
  repoRoot?: string;
  /** Overrides the discovery roots; tests point this at a fixture tree. */
  skillRoots?: SkillRoots;
}

/** `skills` sits at the top level of every config shape that carries it. */
function skillEntriesOf(config: unknown): string[] {
  const entries = (config as { skills?: unknown } | null)?.skills;
  return Array.isArray(entries) ? (entries as string[]) : [];
}

export interface Workflow {
  settings: RunSettings;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  graph: Graph;
  /** Node ids in topological order. */
  order: string[];
}

/**
 * The order validation runs in. Each stage depends on the one before it having
 * passed — there is no point checking that an edge points backwards over a
 * graph that does not parse — so a failure stops the load and leaves every
 * later stage *unevaluated*, which is not the same as passed. `flow-code
 * validate` reports that distinction; a run does not need to, because it stops
 * either way.
 */
export const VALIDATION_STAGES = ['parse', 'file-schema', 'declarations', 'structure'] as const;

export type ValidationStage = (typeof VALIDATION_STAGES)[number];

/** What each stage checks, phrased for a validation report rather than a stack trace. */
export const VALIDATION_STAGE_LABELS: Record<ValidationStage, string> = {
  parse: 'YAML syntax',
  'file-schema': 'file shape and run settings',
  declarations: 'node types, node config, skills, and edge references',
  structure: 'graph structure, loop-backs, and edge conditions',
};

/** The stages that never ran because `failed` stopped the load first. */
export function stagesNotEvaluated(failed: ValidationStage): ValidationStage[] {
  return VALIDATION_STAGES.slice(VALIDATION_STAGES.indexOf(failed) + 1);
}

export class WorkflowValidationError extends Error {
  /**
   * `problems` keeps the shape every existing caller reads. `stage` is
   * additive: it says which check stopped the load, and therefore which checks
   * were never reached.
   */
  constructor(
    readonly problems: string[],
    readonly stage: ValidationStage = 'declarations',
  ) {
    super(`invalid workflow:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'WorkflowValidationError';
  }
}

function describeZodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? ` at \`${issue.path.join('.')}\`` : '';
    return `${prefix}${path}: ${issue.message}`;
  });
}

export function loadWorkflowFromString(source: string, options: LoadOptions = {}): Workflow {
  const repoRoot = options.repoRoot ?? process.cwd();
  const skillRoots = options.skillRoots ?? defaultSkillRoots(repoRoot);
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new WorkflowValidationError(
      [`workflow file is not valid YAML: ${err instanceof Error ? err.message : String(err)}`],
      'parse',
    );
  }

  const fileResult = workflowFileSchema.safeParse(raw);
  if (!fileResult.success) {
    const problems = fileResult.error.issues.map((issue) => {
      const [head, index, ...rest] = issue.path;
      // Name the offending edge or setting rather than a bare path.
      if (head === 'edges' && typeof index === 'number') {
        const edges = (raw as { edges?: unknown[] })?.edges;
        const edge = edges?.[index] as { from?: unknown; to?: unknown } | undefined;
        const label =
          edge && (edge.from !== undefined || edge.to !== undefined)
            ? `edge ${String(edge.from)} -> ${String(edge.to)}`
            : `edge #${index}`;
        const field = rest.length > 0 ? ` (\`${rest.join('.')}\`)` : '';
        return `${label}${field}: ${issue.message}`;
      }
      if (head === 'settings') {
        const field = [index, ...rest].filter((p) => p !== undefined).join('.');
        return `settings${field ? ` \`${field}\`` : ''}: ${issue.message}`;
      }
      const path = issue.path.length > 0 ? ` at \`${issue.path.join('.')}\`` : '';
      return `workflow file${path}: ${issue.message}`;
    });
    throw new WorkflowValidationError(problems, 'file-schema');
  }

  return buildWorkflow(fileResult.data, { repoRoot, skillRoots });
}

/**
 * Everything after the file has parsed and matched its top-level shape:
 * resolve node types and configs, resolve skills, and check the graph.
 *
 * Split out so a graph recorded in a run document can be rehydrated through
 * exactly these checks rather than a second implementation of them. A resumed
 * run and a fresh one therefore agree on what a valid graph is by
 * construction — see `rehydrateGraph`.
 */
export function buildWorkflow(
  file: WorkflowFileRaw,
  context: { repoRoot: string; skillRoots: SkillRoots },
): Workflow {
  const { repoRoot, skillRoots } = context;
  const problems: string[] = [];

  // Node ids must be unique.
  const seenIds = new Set<string>();
  for (const node of file.nodes) {
    if (seenIds.has(node.id)) problems.push(`node \`${node.id}\`: duplicate node id`);
    seenIds.add(node.id);
  }

  // Node type must exist in the registry; config must satisfy its schema.
  const nodes: WorkflowNode[] = [];
  for (const node of file.nodes) {
    const type = getNodeType(node.type);
    if (!type) {
      problems.push(`node \`${node.id}\`: unknown node type \`${node.type}\``);
      continue;
    }
    const configResult = type.configSchema.safeParse(node.config ?? {});
    if (!configResult.success) {
      problems.push(
        ...describeZodIssues(`node \`${node.id}\` (${type.id}) config`, configResult.error),
      );
      continue;
    }
    nodes.push({
      id: node.id,
      type,
      config: configResult.data,
      skills: [],
      ...(node.budget ? { budget: node.budget } : {}),
    });
  }

  // Skills resolve once, here. Discovery is done lazily and only when some node
  // actually names a skill, so the common workflow scans no directories.
  const entriesByNode = nodes.map((n) => ({ node: n, entries: skillEntriesOf(n.config) }));
  if (entriesByNode.some(({ entries }) => entries.length > 0)) {
    const discovered = discoverSkills(skillRoots);
    for (const { node, entries } of entriesByNode) {
      for (const entry of entries) {
        const { skill, searched } = resolveSkillEntry(entry, skillRoots, repoRoot, discovered);
        if (!skill) {
          problems.push(
            `node \`${node.id}\` (${node.type.id}) config at \`skills\`: no skill \`${entry}\` — searched:\n` +
              searched.map((s) => `      ${s}`).join('\n'),
          );
          continue;
        }
        node.skills.push(skill);
      }
    }
  }

  // Edges must reference declared nodes.
  for (const edge of file.edges) {
    for (const end of ['from', 'to'] as const) {
      if (!seenIds.has(edge[end])) {
        problems.push(
          `edge ${edge.from} -> ${edge.to}: \`${end}\` references unknown node \`${edge[end]}\``,
        );
      }
    }
    // A `when:` is parsed here so a typo fails the load rather than becoming an
    // edge that quietly never carries.
    if (edge.when !== undefined) {
      if (edge.loopback) {
        problems.push(
          `edge ${edge.from} -> ${edge.to}: a loop-back cannot carry a \`when\` — a return path is taken because \`${edge.from}\` failed, and that is its condition`,
        );
      }
      try {
        parseCondition(edge.when);
      } catch (err) {
        problems.push(
          `edge ${edge.from} -> ${edge.to} (\`when\`): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (problems.length > 0) throw new WorkflowValidationError(problems, 'declarations');

  const graph = new Graph(
    nodes.map((n) => n.id),
    file.edges,
  );
  let order: string[];
  try {
    order = graph.topologicalOrder();
  } catch (err) {
    if (err instanceof GraphCycleError) {
      // A cycle stops the structural stage here: every check below reads
      // ancestry over the forward-edge subgraph, which a cycle makes meaningless.
      throw new WorkflowValidationError([err.message], 'structure');
    }
    throw err;
  }

  // A loop-back must point backwards over the forward-edge subgraph. Without
  // this the reset scope — the nodes between target and source — is undefined.
  const loopbackProblems: string[] = [];
  for (const loop of graph.allLoopbacks()) {
    if (loop.from === loop.to) {
      loopbackProblems.push(
        `edge ${loop.from} -> ${loop.to}: a loop-back cannot point at its own source`,
      );
      continue;
    }
    if (!graph.ancestorsOf(loop.from).has(loop.to)) {
      loopbackProblems.push(
        `edge ${loop.from} -> ${loop.to}: a loop-back must point back to a node upstream of \`${loop.from}\`, and \`${loop.to}\` is not`,
      );
    }
  }
  // A Test node that rediscovers its own commands and can be re-run by a
  // loop-back is a node that grades work with an exam it also chooses, and gets
  // several attempts to choose an easier one. Reject the combination, not
  // either half of it.
  //
  // Gated on the loop-backs being sound: this check reads `nodesBetween` over
  // them, so running it against a loop-back already known to point the wrong
  // way would report a second problem about the same broken edge.
  const autoProblems: string[] = [];
  for (const node of loopbackProblems.length > 0 ? [] : nodes) {
    if (node.type.id !== 'test') continue;
    if ((node.config as { commands?: unknown }).commands !== TEST_COMMANDS_AUTO) continue;
    for (const loop of graph.allLoopbacks()) {
      if (!graph.nodesBetween(loop.to, loop.from).has(node.id)) continue;
      autoProblems.push(
        `node \`${node.id}\` (test): \`commands: ${TEST_COMMANDS_AUTO}\` cannot be combined with retry — ` +
          `the loop-back ${loop.from} -> ${loop.to} re-runs this node, which would let it rediscover an easier ` +
          `set of commands on each attempt. Use an explicit command list, or remove that loop-back.`,
      );
      break;
    }
  }
  // A condition may only read a node whose output is guaranteed to exist by
  // the time the edge is evaluated: the edge's own source, or an ancestor of
  // it. Anything else is a race the graph cannot honour.
  const conditionProblems: string[] = [];
  for (const { from, to, condition } of graph.allConditionals()) {
    const label = `edge ${from} -> ${to} (\`when: ${condition.source}\`)`;
    if (!seenIds.has(condition.nodeId)) {
      conditionProblems.push(`${label}: references unknown node \`${condition.nodeId}\``);
      continue;
    }
    if (condition.nodeId !== from && !graph.ancestorsOf(from).has(condition.nodeId)) {
      conditionProblems.push(
        `${label}: can only read \`${from}\` or a node upstream of it, and \`${condition.nodeId}\` is neither — its output may not exist yet when this edge is evaluated`,
      );
    }
  }
  // The three structural checks above are independent of each other, so they
  // are reported together rather than one build at a time.
  const structureProblems = [...loopbackProblems, ...autoProblems, ...conditionProblems];
  if (structureProblems.length > 0) throw new WorkflowValidationError(structureProblems, 'structure');

  return {
    settings: file.settings ?? DEFAULT_SETTINGS,
    nodes,
    edges: file.edges,
    graph,
    order,
  };
}

export function loadWorkflow(repoRoot: string, options: LoadOptions = {}): Workflow {
  const path = join(repoRoot, WORKFLOW_RELATIVE_PATH);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new WorkflowValidationError(
      [`no workflow file found at ${path} — run \`flow-code init\` to scaffold one`],
      'parse',
    );
  }
  return loadWorkflowFromString(source, { repoRoot, ...options });
}
