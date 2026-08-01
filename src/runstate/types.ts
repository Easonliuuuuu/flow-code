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

export interface NodeRunState {
  status: NodeStatus;
  statusDetail?: string;
  output?: unknown;
  /** Count of denied tool calls, for the blocked-action indicator. */
  denials: number;
  workingDir?: string;
}

export interface RunState {
  runId: string;
  createdAt: string;
  repoRoot: string;
  pid: number;
  baseline: RunBaseline | null;
  nodes: Record<string, NodeRunState>;
  worktrees: WorktreeRecord[];
  activity: ActivityEntry[];
  finishedAt?: string;
}
