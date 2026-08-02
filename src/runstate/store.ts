import { randomUUID } from 'node:crypto';
import type {
  ActivityEntry,
  AttemptRecord,
  DiscussTranscriptEntry,
  NodeRunState,
  NodeStatus,
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
    nodeIds: string[];
    /**
     * Continue a previously-interrupted run under its own runId: nodes
     * already `done` keep their recorded state; everything else resets to
     * `idle` but keeps its Discuss transcript/session id, so `--resume`
     * picks the conversation back up instead of starting blank.
     */
    resumeFrom?: RunState;
  }) {
    const nodes: Record<string, NodeRunState> = {};
    for (const id of opts.nodeIds) {
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

  node(id: string): NodeRunState {
    const node = this.state.nodes[id];
    if (!node) throw new Error(`unknown node in run-state: ${id}`);
    return node;
  }

  setBaseline(baseline: RunBaseline): void {
    this.state.baseline = baseline;
    this.commit();
  }

  setStatus(nodeId: string, status: NodeStatus, detail?: string): void {
    const node = this.node(nodeId);
    const now = new Date().toISOString();
    const terminal = status === 'done' || status === 'error' || status === 'skipped';
    this.state.nodes = {
      ...this.state.nodes,
      [nodeId]: {
        ...node,
        status,
        ...(detail !== undefined ? { statusDetail: detail } : {}),
        // Timestamps bracket the node's wall-clock time, which the UI shows
        // live while it runs and freezes once it finishes. `startedAt` is
        // only stamped once, so a mid-run status detail update (running →
        // running) doesn't restart the clock.
        ...(status === 'running' && node.startedAt === undefined ? { startedAt: now } : {}),
        ...(terminal ? { endedAt: now } : {}),
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
    const prev = node.tokens ?? { input: 0, output: 0, cached: 0 };
    const tokens: TokenUsage = {
      input: prev.input + (delta.input ?? 0),
      output: prev.output + (delta.output ?? 0),
      cached: prev.cached + (delta.cached ?? 0),
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
