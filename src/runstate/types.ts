import type { NodeBudget, RunSettings, WorkflowEdge } from '../workflow/schema.js';
import type { RunEnforcement } from './tier.js';

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

/**
 * How an Approval-Gate was answered, and through what.
 *
 * The surface is recorded rather than assumed because it is the whole of the
 * guarantee: under an engine-driven run the decision came from the UI's own
 * prompt, and in a host session it came from a surface the host cannot answer
 * on the user's behalf. An approval whose provenance is unknown is not one
 * anybody can rely on after the fact.
 */
export interface GateDecision {
  decision: 'approved' | 'rejected';
  /** What collected it — `ui`, `permission-prompt`, `terminal`. */
  surface: string;
  at: string;
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
 *
 * The two cache terms are kept apart because they behave nothing alike. A
 * cache *write* happens once per new prefix and is billed above base input; a
 * cache *read* happens on every subsequent turn, is billed at a fraction of
 * it, and therefore grows with how long a session runs rather than with how
 * much work it does. Collapsing them into one number is what made
 * {@link budgetedTokens} impossible to state honestly.
 */
export interface TokenUsage {
  /** Fresh (uncached) prompt tokens. */
  input: number;
  output: number;
  /** Prompt tokens written to the provider's cache. */
  cacheWrite: number;
  /** Prompt tokens served from the provider's cache. */
  cacheRead: number;
}

/**
 * Run files written before the two cache terms were separated carry a single
 * `cached` field holding their sum. It is only ever read, and it is counted as
 * cache reads, which is what it overwhelmingly was — reads outnumber writes by
 * roughly the number of turns in a session.
 */
interface LegacyTokenUsage {
  cached?: number;
}

function cacheReadOf(usage: TokenUsage): number {
  const legacy = (usage as TokenUsage & LegacyTokenUsage).cached;
  return usage.cacheRead ?? legacy ?? 0;
}

function cacheWriteOf(usage: TokenUsage): number {
  return usage.cacheWrite ?? 0;
}

/** Every token the provider moved — what the UI reports. */
export function sumTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  return usage.input + usage.output + cacheReadOf(usage) + cacheWriteOf(usage);
}

/** Prompt-side tokens: fresh input plus both cache terms. */
export function promptTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  return usage.input + cacheReadOf(usage) + cacheWriteOf(usage);
}

/** Prompt tokens served from cache — reported, never budgeted. */
export function cacheReadTokens(usage: TokenUsage | undefined): number {
  return usage ? cacheReadOf(usage) : 0;
}

/** Prompt tokens written to cache — reported, and budgeted. */
export function cacheWriteTokens(usage: TokenUsage | undefined): number {
  return usage ? cacheWriteOf(usage) : 0;
}

/**
 * What a budget counts: everything except tokens served from cache.
 *
 * A budget exists to stop a run that is spending without bound, so it has to
 * track work done rather than context re-sent. Cache reads are neither: a
 * long session re-reads the same cached prefix on every turn, so counting
 * them makes the ceiling a measure of how many turns have passed. In
 * practice that dominated everything else — a two-function change was
 * observed spending 154 fresh input tokens, 403 output tokens, and 2,077,069
 * cache reads, which exhausted the scaffolded 2,000,000-token run budget
 * before the Test node ever ran. Cache reads are also the cheapest thing on
 * the bill, at a fraction of base input, so counting them at full weight
 * overstated cost by an order of magnitude in the same breath.
 *
 * Cache *writes* stay counted: they are billed above base input and they grow
 * with context, which is exactly the runaway a token ceiling should catch. A
 * run that spins without writing new context is bounded by `minutesPerRun`,
 * which is the backstop suited to it.
 */
export function budgetedTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  return usage.input + usage.output + cacheWriteOf(usage);
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
  /** Set on an Approval-Gate once answered — see {@link GateDecision}. */
  gateDecision?: GateDecision;
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

/**
 * Who owns a run document — the one process permitted to write it.
 *
 * Two identities, because a writer and a reader can establish different
 * things. `token` is random per store instance and held in memory by the
 * writer, so comparing it against the document on disk answers "is this still
 * mine?" exactly. A reader has nothing to compare a token against, so it is
 * left with `pid` and `host`, which can only ever support an estimate — see
 * {@link driverLiveness}. Keeping both here is what lets each side claim
 * precisely as much as it can actually know.
 */
export interface RunOwner {
  /** Owning process on {@link host}. Recyclable, and meaningless without it. */
  pid: number;
  /** Machine the owner runs on. A document from elsewhere cannot have its pid checked here. */
  host: string;
  /** Random per-writer token. Proves ownership; proves nothing about liveness. */
  token: string;
  claimedAt: string;
}

/** One ownership transfer, recorded so a resumed run is distinguishable from one driven throughout. */
export interface OwnershipHandover {
  from: { pid: number; host: string };
  at: string;
}

export interface RunState {
  runId: string;
  createdAt: string;
  repoRoot: string;
  /**
   * The owning process's pid, kept for run documents written before {@link
   * RunState.owner} existed and for readers that only ever wanted this. New
   * code should read `owner`, which says which machine the pid belongs to.
   */
  pid: number;
  /**
   * Optional only so documents written before ownership was recorded still
   * parse. Their liveness is unknowable, which is the honest answer for them.
   */
  owner?: RunOwner;
  /** Present once a run has changed hands, e.g. through `--resume`. */
  handovers?: OwnershipHandover[];
  /**
   * What was actually in force while this run executed — see {@link
   * RunEnforcement}. Optional only so run documents written before tiers
   * existed still parse; every one of those was engine-driven, since the
   * engine was the only writer that existed.
   */
  enforcement?: RunEnforcement;
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
