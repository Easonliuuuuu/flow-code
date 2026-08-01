import { randomUUID } from 'node:crypto';
import type {
  ActivityEntry,
  NodeRunState,
  NodeStatus,
  RunBaseline,
  RunState,
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

  constructor(opts: { runId?: string; repoRoot: string; nodeIds: string[] }) {
    const nodes: Record<string, NodeRunState> = {};
    for (const id of opts.nodeIds) nodes[id] = { status: 'idle', denials: 0 };
    this.state = {
      runId: opts.runId ?? randomUUID(),
      createdAt: new Date().toISOString(),
      repoRoot: opts.repoRoot,
      pid: process.pid,
      baseline: null,
      nodes,
      worktrees: [],
      activity: [],
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
    this.state.nodes = {
      ...this.state.nodes,
      [nodeId]: {
        ...node,
        status,
        ...(detail !== undefined ? { statusDetail: detail } : {}),
      },
    };
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

  markFinished(): void {
    this.state.finishedAt = new Date().toISOString();
    this.commit();
  }

  allTerminal(): boolean {
    return Object.values(this.state.nodes).every(
      (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped',
    );
  }
}
