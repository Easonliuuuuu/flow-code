import type { NodeBudget, RunSettings, WorkflowEdge } from '../workflow/schema.js';

export const NODE_STATUSES = ['idle', 'running', 'waiting', 'done', 'error', 'skipped'] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * One row of a node's tool-call activity log. Appended from the harness
 * interception point (never from the UI), so headless runs record it too.
 */
export interface ActivityEntry {
  ts: string;
  nodeId: string;
  /** Distinguishes worktree instances within one node. */
  instanceId?: string;
  /**
   * Which agent inside the node made the call. Absent means the node's own
   * session — which is what every entry written before subagents existed
   * means, so old run files stay correct with no migration.
   */
  agentId?: string;
  /** The registry name of that agent (`explore`, …); absent alongside `agentId`. */
  agentType?: string;
  tool: string;
  /** The command string or a short input summary. */
  summary: string;
  decision: 'allowed' | 'denied';
  /** Set on denials: which capability the node type lacks. */
  missingCapability?: string;
  /** Set once an allowed call finishes. */
  durationMs?: number;
  exitStatus?: number | null;
  error?: string;
  toolUseId?: string;
}

export interface WorktreeRecord {
  nodeId: string;
  instanceId: string;
  branch: string;
  dir: string;
  removed: boolean;
  converged: boolean;
}

export interface RunBaseline {
  /** Commit sha at run start. */
  commit: string;
  /**
   * Tree sha every diff in the run is computed against. Equals the commit's
   * tree on a clean start; under the dirty-tree override it is a snapshot of
   * the working tree as it existed at run start.
   */
  tree: string;
  dirtyOverride: boolean;
}

export interface DiscussTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

/** The terminal outcome of one attempt, kept when a loop-back resets a node. */
export interface AttemptRecord {
  status: NodeStatus;
  detail?: string;
  endedAt: string;
}

/**
 * Tokens a node has consumed so far, accumulated across every API call it
 * makes (and, for a fan-out node, across all of its instances). Absent on
 * node types with no agent session — they cost nothing.
 */
export interface TokenUsage {
  /** Fresh (uncached) prompt tokens. */
  input: number;
  output: number;
  /** Prompt tokens served from, or written to, the provider's cache. */
  cached: number;
}

/** Every token a usage record accounts for — what a budget is measured against. */
export function sumTokens(usage: TokenUsage | undefined): number {
  return usage ? usage.input + usage.cached + usage.output : 0;
}

export interface NodeRunState {
  status: NodeStatus;
  statusDetail?: string;
  output?: unknown;
  /** Set the first time the node enters `running`; cleared by a loop-back reset. */
  startedAt?: string;
  /** Set when the node reaches a terminal status; cleared by a loop-back reset. */
  endedAt?: string;
  /** Cumulative across attempts: what this node has cost, not what this attempt cost. */
  tokens?: TokenUsage;
  /**
   * Why a `skipped` node was skipped, which decides what it means downstream:
   *  - `condition`: a routing condition sent the run down another branch. The
   *    branch was not taken, so it does not block a node that also has a live
   *    path into it (the two arms of a diamond rejoining at a gate).
   *  - `upstream`: something above it failed or never completed. That *does*
   *    block everything below, exactly as it always has.
   */
  skipReason?: 'condition' | 'upstream';
  /**
   * Which attempt this node is on, counting from 1. Greater than 1 only when
   * a loop-back has reset and re-run it.
   */
  attempt?: number;
  /** Terminal outcome of each earlier attempt, oldest first. */
  priorAttempts?: AttemptRecord[];
  /** Count of denied tool calls, for the blocked-action indicator. */
  denials: number;
  /**
   * Subagents this node has running right now — not a total. Drops back to 0
   * as they finish, so the card shows delegation while it is happening rather
   * than a tally afterwards.
   */
  subagents?: number;
  workingDir?: string;
  /** Persisted Discuss transcript, so an interrupted conversation survives to `--resume`. */
  discussTranscript?: DiscussTranscriptEntry[];
  /** Underlying agent session id, so `--resume` can continue it with full context. */
  sessionId?: string;
  /**
   * Ids of the skills this node ran with, so its behavior can be attributed to
   * the instructions it was actually given rather than to its node type alone.
   */
  skills?: string[];
}

/** What the provider last said about one of its rate-limit windows. */
export interface RateLimitWindowState {
  /** Percentage of the window consumed, 0–100, as the provider reports it. */
  utilization: number;
  /** The provider's verdict when it last reported this window. */
  status: 'allowed' | 'allowed_warning' | 'rejected';
}

/**
 * Plan rate-limit utilization for the run, as reported by the provider.
 *
 * Run-global rather than per-node, and deliberately *recorded* rather than
 * computed: these windows are billed against the account across every session
 * the plan has ever run, so nothing flow-code observes locally could
 * reconstruct them. That also makes them the one cost signal a node fanning
 * out into concurrent sessions cannot cause us to under-count.
 *
 * Absent means unknown, never zero. Providers with no such concept — API-key,
 * Bedrock and Vertex sessions, and every non-Claude runner — never report, and
 * a meter reading 0% for them would be worse than no meter at all.
 */
export interface RateLimits {
  /**
   * Window id (`five_hour`, `seven_day`, …) → what the provider last said.
   * Open rather than a closed union: a window this build has never heard of
   * should still surface as a meter instead of vanishing.
   */
  windows: Record<string, RateLimitWindowState>;
  /** When the provider last reported — a stale meter is worth being able to spot. */
  updatedAt: string;
}

/**
 * One node as recorded in a run document: enough to rebuild it, and nothing
 * that cannot survive JSON. `type` is the registry id rather than the type
 * definition, because a definition carries zod schemas and predicate
 * functions; it is re-resolved against the registry on read.
 */
export interface RecordedNode {
  id: string;
  /** Registry id of the node type (`implement`, `test`, …). */
  type: string;
  /** Config as validated at load time, with the type's defaults applied. */
  config: unknown;
  budget?: NodeBudget;
}

/**
 * The graph a run is executing, recorded in its own run document.
 *
 * This is what makes a run self-describing: a reader renders and resumes from
 * this rather than re-loading `.flow-code/workflow.yaml`, which may have been
 * edited — or replaced — since the run began.
 *
 * Deliberately a projection, not the loaded `Workflow`: adjacency and
 * topological order are derived, and serializing derived structure invites it
 * to disagree with the code that reads it. Both are recomputed on rehydration.
 */
export interface RecordedGraph {
  nodes: RecordedNode[];
  edges: WorkflowEdge[];
  /** Run-wide settings as they applied to this run. */
  settings: RunSettings;
  /** Which named graph this run selected, when the file declared more than one. */
  selected?: string;
}

export interface RunState {
  runId: string;
  createdAt: string;
  repoRoot: string;
  pid: number;
  baseline: RunBaseline | null;
  /**
   * The graph this run is executing. Optional only so run documents written
   * before runs recorded their own shape still parse; a reader that finds it
   * absent reports the shape as unavailable rather than substituting whatever
   * the workflow file currently says.
   */
  graph?: RecordedGraph;
  nodes: Record<string, NodeRunState>;
  worktrees: WorktreeRecord[];
  activity: ActivityEntry[];
  /** Absent until a provider that has plan limits reports one. */
  rateLimits?: RateLimits;
  finishedAt?: string;
  /** True when the run ended via ctrl+c/SIGTERM rather than completing on its own; `--resume` looks for this. */
  interrupted?: boolean;
}
