import { randomUUID } from 'node:crypto';
import { budgetedTokens } from './types.js';
import type {
  ActivityEntry,
  AttemptRecord,
  DiscussTranscriptEntry,
  NodeRunState,
  NodeStatus,
  RateLimitWindowState,
  RecordedGraph,
  RunBaseline,
  RunState,
  TokenUsage,
  WorktreeRecord,
} from './types.js';

export type StoreListener = (state: RunState) => void;

export interface StorePersister {
  persist(state: RunState): void;
}

/**
 * Central run-state store. The engine and harness write into it; the UI (and
 * the persister) subscribe to it. It has no dependency on the rendering
 * layer, so runs record identical state with no UI attached.
 */
export class RunStateStore {
  private state: RunState;
  private listeners = new Set<StoreListener>();
  /** In-memory only: live streamed output per node, for the detail view. */
  private liveOutput = new Map<string, string>();
  private persister: StorePersister | undefined;

  constructor(opts: {
    runId?: string;
    repoRoot: string;
    /** Ignored when `graph` is given — a recorded graph is then the authority on which nodes exist. */
    nodeIds?: string[];
    /**
     * The graph this run executes, recorded into the document so the run
     * describes itself. Without it a reader can only report the shape as
     * unavailable, which is what run documents written before this existed do.
     */
    graph?: RecordedGraph;
    /**
     * Continue a previously-interrupted run under its own runId: nodes
     * already `done` keep their recorded state; everything else resets to
     * `idle` but keeps its Discuss transcript/session id, so `--resume`
     * picks the conversation back up instead of starting blank.
     */
    resumeFrom?: RunState;
  }) {
    // One source for which nodes exist, so the node map and the recorded graph
    // cannot be seeded from two lists that disagree.
    const nodeIds = opts.graph ? opts.graph.nodes.map((n) => n.id) : (opts.nodeIds ?? []);
    const nodes: Record<string, NodeRunState> = {};
    for (const id of nodeIds) {
      const prior = opts.resumeFrom?.nodes[id];
      if (!prior) {
        nodes[id] = { status: 'idle', denials: 0 };
      } else if (prior.status === 'done') {
        nodes[id] = prior;
      } else {
        nodes[id] = {
          status: 'idle',
          denials: 0,
          ...(prior.discussTranscript ? { discussTranscript: prior.discussTranscript } : {}),
          ...(prior.sessionId ? { sessionId: prior.sessionId } : {}),
        };
      }
    }
    this.state = {
      runId: opts.resumeFrom?.runId ?? opts.runId ?? randomUUID(),
      createdAt: opts.resumeFrom?.createdAt ?? new Date().toISOString(),
      repoRoot: opts.repoRoot,
      pid: process.pid,
      baseline: opts.resumeFrom?.baseline ?? null,
      // Recorded at construction, which is before any node can leave `idle`:
      // a reader attaching to a run at its first instant still sees the shape.
      ...(opts.graph ? { graph: opts.graph } : {}),
      nodes,
      worktrees: opts.resumeFrom?.worktrees ?? [],
      activity: opts.resumeFrom?.activity ?? [],
    };
  }

  attachPersister(persister: StorePersister): void {
    this.persister = persister;
    this.persister.persist(this.state);
  }

  get runId(): string {
    return this.state.runId;
  }

  snapshot(): RunState {
    return this.state;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(): void {
    this.state = { ...this.state };
    this.persister?.persist(this.state);
    for (const l of this.listeners) l(this.state);
  }

  /**
   * Replaces the whole state and notifies subscribers — the write path for a
   * read-only viewer (`flow-code watch`) driven by a file on disk rather than
   * by an engine in this process.
   *
   * Deliberately not `commit()`: this must never reach the persister. A
   * viewer that wrote back what it just read would race the process actually
   * running the workflow, and could resurrect state the run had already moved
   * past.
   */
  applySnapshot(state: RunState): void {
    this.state = state;
    for (const l of this.listeners) l(this.state);
  }

  node(id: string): NodeRunState {
    const node = this.state.nodes[id];
    if (!node) throw new Error(`unknown node in run-state: ${id}`);
    return node;
  }

  setBaseline(baseline: RunBaseline): void {
    this.state.baseline = baseline;
    this.commit();
  }

  /**
   * A detail belongs to the state that set it.
   *
   * Carrying one across a transition is how a Test node that ran `npm test`
   * and passed went on reporting "no test command set yet" — the detail it
   * had while `waiting` for the command it then received. So a status change
   * with no detail of its own clears it, and only a same-status update keeps
   * it: `running → running` is an executor refining what it is doing, which
   * is exactly the case that must not lose the line it just wrote.
   */
  setStatus(nodeId: string, status: NodeStatus, detail?: string): void {
    const node = this.node(nodeId);
    const now = new Date().toISOString();
    const terminal = status === 'done' || status === 'error' || status === 'skipped';
    const next: NodeRunState = {
      ...node,
      status,
      // Timestamps bracket the node's wall-clock time, which the UI shows
      // live while it runs and freezes once it finishes. `startedAt` is
      // only stamped once, so a mid-run status detail update (running →
      // running) doesn't restart the clock.
      ...(status === 'running' && node.startedAt === undefined ? { startedAt: now } : {}),
      ...(terminal ? { endedAt: now } : {}),
    };
    if (detail !== undefined) next.statusDetail = detail;
    else if (status !== node.status) delete next.statusDetail;
    this.state.nodes = { ...this.state.nodes, [nodeId]: next };
    this.commit();
  }

  /**
   * Skip a node, recording *why* — the distinction downstream scheduling turns
   * on (see `NodeRunState.skipReason`).
   */
  setSkipped(nodeId: string, reason: 'condition' | 'upstream', detail: string): void {
    const node = this.node(nodeId);
    this.state.nodes = {
      ...this.state.nodes,
      [nodeId]: {
        ...node,
        status: 'skipped',
        statusDetail: detail,
        skipReason: reason,
        endedAt: new Date().toISOString(),
      },
    };
    this.commit();
  }

  /**
   * Accumulate token usage reported by a runner. Deltas, not totals: every
   * API response adds its own usage, so the count climbs live during a
   * session and survives across attempts (a loop-back re-run adds to the
   * node's bill rather than resetting it).
   */
  addTokens(nodeId: string, delta: Partial<TokenUsage>): void {
    const node = this.node(nodeId);
    const prev = node.tokens ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const tokens: TokenUsage = {
      input: prev.input + (delta.input ?? 0),
      output: prev.output + (delta.output ?? 0),
      cacheWrite: (prev.cacheWrite ?? 0) + (delta.cacheWrite ?? 0),
      cacheRead: (prev.cacheRead ?? 0) + (delta.cacheRead ?? 0),
    };
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, tokens } };
    this.commit();
  }

  /**
   * Which attempt a node is on, counting from 1. Run-state written before
   * loop-backs existed has no counter, and reads as a first attempt.
   */
  attemptOf(nodeId: string): number {
    return this.node(nodeId).attempt ?? 1;
  }

  /**
   * Return a node to `idle` for another attempt, as a loop-back does. Results
   * of the finished attempt are cleared — a stale output would otherwise look
   * like this attempt's — while its outcome is kept in `priorAttempts`. The
   * activity log is append-only and is never cleared: it is the record of what
   * actually ran, across every attempt.
   */
  resetNode(nodeId: string): void {
    const node = this.node(nodeId);
    const prior: AttemptRecord = {
      status: node.status,
      ...(node.statusDetail !== undefined ? { detail: node.statusDetail } : {}),
      endedAt: new Date().toISOString(),
    };
    // Tokens deliberately survive: they are what the node has already cost,
    // and a new attempt adds to that rather than starting the bill over.
    const {
      output: _output,
      statusDetail: _statusDetail,
      startedAt: _startedAt,
      endedAt: _endedAt,
      skipReason: _skipReason,
      ...rest
    } = node;
    this.state.nodes = {
      ...this.state.nodes,
      [nodeId]: {
        ...rest,
        status: 'idle',
        attempt: this.attemptOf(nodeId) + 1,
        priorAttempts: [...(node.priorAttempts ?? []), prior],
      },
    };
    this.liveOutput.delete(nodeId);
    this.commit();
  }

  setOutput(nodeId: string, output: unknown): void {
    const node = this.node(nodeId);
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, output } };
    this.commit();
  }

  setWorkingDir(nodeId: string, workingDir: string): void {
    const node = this.node(nodeId);
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, workingDir } };
    this.commit();
  }

  /** Append an activity entry; returns it for later completion. */
  appendActivity(entry: ActivityEntry): ActivityEntry {
    if (entry.decision === 'denied') {
      const node = this.node(entry.nodeId);
      this.state.nodes = {
        ...this.state.nodes,
        [entry.nodeId]: { ...node, denials: node.denials + 1 },
      };
    }
    this.state.activity = [...this.state.activity, entry];
    this.commit();
    return entry;
  }

  /** Complete a previously appended (allowed) entry with its execution result. */
  completeActivity(
    toolUseId: string,
    result: { durationMs: number; exitStatus?: number | null; error?: string },
  ): void {
    let changed = false;
    this.state.activity = this.state.activity.map((e) => {
      if (e.toolUseId !== toolUseId || e.durationMs !== undefined) return e;
      changed = true;
      return { ...e, ...result };
    });
    if (changed) this.commit();
  }

  activityFor(nodeId: string): ActivityEntry[] {
    return this.state.activity.filter((e) => e.nodeId === nodeId);
  }

  addWorktree(record: WorktreeRecord): void {
    this.state.worktrees = [...this.state.worktrees, record];
    this.commit();
  }

  updateWorktree(dir: string, patch: Partial<WorktreeRecord>): void {
    this.state.worktrees = this.state.worktrees.map((w) =>
      w.dir === dir ? { ...w, ...patch } : w,
    );
    this.commit();
  }

  appendLiveOutput(nodeId: string, text: string): void {
    const prev = this.liveOutput.get(nodeId) ?? '';
    // Keep a bounded tail so long sessions don't grow memory without limit.
    const next = (prev + text).slice(-64_000);
    this.liveOutput.set(nodeId, next);
    this.commit();
  }

  liveOutputFor(nodeId: string): string {
    return this.liveOutput.get(nodeId) ?? '';
  }

  appendDiscussMessage(nodeId: string, entry: DiscussTranscriptEntry): void {
    const node = this.node(nodeId);
    const discussTranscript = [...(node.discussTranscript ?? []), entry];
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, discussTranscript } };
    this.commit();
  }

  setSessionId(nodeId: string, sessionId: string): void {
    const node = this.node(nodeId);
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, sessionId } };
    this.commit();
  }

  /** Record which skills a node ran with; idempotent across re-attempts. */
  setSkills(nodeId: string, skills: string[]): void {
    const node = this.node(nodeId);
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, skills } };
    this.commit();
  }

  /**
   * Merge one provider rate-limit report into the run's snapshot. Merged, not
   * replaced: each report carries a single window, so the five-hour and
   * seven-day meters arrive on separate events and must not evict each other.
   */
  recordRateLimit(window: string, state: RateLimitWindowState): void {
    this.state.rateLimits = {
      windows: { ...this.state.rateLimits?.windows, [window]: state },
      updatedAt: new Date().toISOString(),
    };
    this.commit();
  }

  /**
   * Move a node's in-flight subagent count. A delta rather than an absolute
   * so concurrent instances of one node cannot clobber each other's counts;
   * clamped at zero so a stray stop can never drive it negative.
   */
  addSubagents(nodeId: string, delta: number): void {
    const node = this.node(nodeId);
    const subagents = Math.max(0, (node.subagents ?? 0) + delta);
    this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, subagents } };
    this.commit();
  }

  /**
   * Tokens one node has spent against its budget, across every attempt — see
   * {@link budgetedTokens} for why that is not every token it moved.
   */
  tokensFor(nodeId: string): number {
    return budgetedTokens(this.node(nodeId).tokens);
  }

  /** Tokens the whole run has spent against its budget. */
  totalTokens(): number {
    return Object.values(this.state.nodes).reduce((sum, n) => sum + budgetedTokens(n.tokens), 0);
  }

  markFinished(interrupted = false): void {
    this.state.finishedAt = new Date().toISOString();
    this.state.interrupted = interrupted;
    this.commit();
  }

  allTerminal(): boolean {
    return Object.values(this.state.nodes).every(
      (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped',
    );
  }
}
