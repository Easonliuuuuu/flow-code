import type { NodeTypeId } from '../registry/index.js';
import type { RunStateStore } from '../runstate/store.js';
import type { RunBaseline } from '../runstate/types.js';
import type { Workflow, WorkflowNode } from '../workflow/load.js';
import type {
  ExecuteContext,
  InteractionPorts,
  NodeExecutor,
  SessionRunner,
  UpstreamInput,
} from './types.js';

/** Above this, an upstream output is injected truncated (full value stays in run-state). */
export const UPSTREAM_OUTPUT_LIMIT = 16 * 1024;
export const TRUNCATION_MARKER = '…[truncated by flow-code: full output in run-state]';

class Semaphore {
  private queue: Array<() => void> = [];
  private available: number;

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.available++;
    };
  }
}

export interface EngineOptions {
  workflow: Workflow;
  store: RunStateStore;
  repoRoot: string;
  baseline: RunBaseline;
  ports: InteractionPorts;
  sessions: SessionRunner;
  executors: Record<NodeTypeId, NodeExecutor>;
  /** Aborted to interrupt the run (e.g. ctrl+c); defaults to a signal that never fires. */
  signal?: AbortSignal;
}

/**
 * DAG executor. Starts nodes when their dependencies are satisfied, but
 * serializes every node that operates on the shared main working tree —
 * true concurrency exists only between Worktree-Agent instances (which the
 * worktree executor runs under the session-slot semaphore).
 */
export class Engine {
  private readonly wf: Workflow;
  private readonly store: RunStateStore;
  private readonly opts: EngineOptions;
  private readonly sessionSlots: Semaphore;
  private readonly signal: AbortSignal;
  private mainTreeLockHolder: string | null = null;
  private readonly running = new Map<string, Promise<void>>();

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.wf = opts.workflow;
    this.store = opts.store;
    this.sessionSlots = new Semaphore(opts.workflow.settings.concurrency);
    this.signal = opts.signal ?? new AbortController().signal;
  }

  private nodeById(id: string): WorkflowNode {
    const node = this.wf.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`unknown node ${id}`);
    return node;
  }

  /** Worktree-Agent orchestrates isolated dirs; the gate only waits and reads. */
  private takesMainTreeLock(node: WorkflowNode): boolean {
    return node.type.id !== 'worktree-agent' && node.type.id !== 'approval-gate';
  }

  private discussActive(): boolean {
    return this.wf.nodes.some((n) => {
      if (n.type.id !== 'discuss') return false;
      const status = this.store.node(n.id).status;
      return status === 'running' || status === 'waiting';
    });
  }

  private depsSatisfied(id: string): boolean {
    return this.wf.graph
      .directDependencies(id)
      .every((dep) => this.store.node(dep).status === 'done');
  }

  /**
   * A starting node receives the recorded outputs of its direct upstream
   * dependencies only — fan-in bounds context growth, not graph depth.
   */
  private upstreamInputs(id: string): UpstreamInput[] {
    return this.wf.graph.directDependencies(id).map((depId) => {
      const dep = this.nodeById(depId);
      const output = this.store.node(depId).output;
      let json = JSON.stringify(output ?? null, null, 2);
      let truncated = false;
      if (json.length > UPSTREAM_OUTPUT_LIMIT) {
        json = json.slice(0, UPSTREAM_OUTPUT_LIMIT) + TRUNCATION_MARKER;
        truncated = true;
      }
      return { nodeId: depId, typeId: dep.type.id, outputJson: json, truncated };
    });
  }

  /**
   * A node downstream of a Worktree-Agent convergence runs in the converged
   * working directory, not the repository's main checkout.
   */
  private workingDirFor(id: string): string {
    const queue = [...this.wf.graph.directDependencies(id)];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = this.nodeById(depId);
      if (dep.type.id === 'worktree-agent') {
        const output = this.store.node(depId).output as { convergedDir?: string } | undefined;
        if (output?.convergedDir) return output.convergedDir;
      }
      queue.push(...this.wf.graph.directDependencies(depId));
    }
    return this.opts.repoRoot;
  }

  private markDownstreamSkipped(id: string): void {
    for (const downstream of this.wf.graph.downstreamOf(id)) {
      const status = this.store.node(downstream).status;
      if (status === 'idle' || status === 'waiting') {
        this.store.setStatus(downstream, 'skipped', `upstream ${id} did not complete`);
      }
    }
  }

  private async runNode(node: WorkflowNode): Promise<void> {
    const workingDir = this.workingDirFor(node.id);
    this.store.setWorkingDir(node.id, workingDir);

    const ctx: ExecuteContext = {
      runId: this.store.runId,
      node,
      workflow: this.wf,
      repoRoot: this.opts.repoRoot,
      workingDir,
      baseline: this.opts.baseline,
      settings: this.wf.settings,
      upstream: this.upstreamInputs(node.id),
      store: this.store,
      ports: this.opts.ports,
      sessions: this.opts.sessions,
      acquireSessionSlot: () => this.sessionSlots.acquire(),
      signal: this.signal,
    };

    const executor = this.opts.executors[node.type.id];
    let sawError = false;
    try {
      for await (const event of executor(ctx)) {
        if (event.type === 'status') {
          this.store.setStatus(node.id, event.status, event.detail);
          if (event.status === 'error') sawError = true;
        } else if (event.type === 'output') {
          this.store.appendLiveOutput(node.id, event.text);
        } else {
          const parsed = node.type.outputSchema.safeParse(event.output);
          if (!parsed.success) {
            throw new Error(
              `node output does not match the ${node.type.id} output schema: ${parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}`,
            );
          }
          this.store.setOutput(node.id, parsed.data);
        }
      }
      const finalStatus = this.store.node(node.id).status;
      if (finalStatus !== 'done' && finalStatus !== 'error') {
        // An executor that returns without a terminal status completed.
        this.store.setStatus(node.id, 'done');
      }
    } catch (err) {
      sawError = true;
      this.store.setStatus(node.id, 'error', err instanceof Error ? err.message : String(err));
    }
    if (sawError || this.store.node(node.id).status === 'error') {
      this.markDownstreamSkipped(node.id);
    }
  }

  private startEligible(): void {
    // Interrupted: let in-flight nodes unwind (they'll reject on the shared
    // signal) but never begin new work.
    if (this.signal.aborted) return;
    for (const id of this.wf.order) {
      const node = this.nodeById(id);
      if (this.store.node(id).status !== 'idle') continue;
      if (!this.depsSatisfied(id)) continue;
      // A Discuss node holds the whole run: nothing new starts while one is active.
      if (this.discussActive()) break;
      const needsLock = this.takesMainTreeLock(node);
      if (needsLock && this.mainTreeLockHolder !== null) continue;
      if (needsLock) this.mainTreeLockHolder = id;

      const promise = this.runNode(node).finally(() => {
        if (this.mainTreeLockHolder === id) this.mainTreeLockHolder = null;
        this.running.delete(id);
      });
      this.running.set(id, promise);

      // Starting a Discuss node freezes further starts this pass.
      if (node.type.id === 'discuss') break;
    }
  }

  async run(): Promise<void> {
    try {
      while (!this.store.allTerminal()) {
        this.startEligible();
        if (this.running.size === 0) {
          if (!this.store.allTerminal()) {
            // Defensive: nothing running and nothing startable — mark the
            // stragglers so the run terminates rather than spinning.
            const reason = this.signal.aborted
              ? 'run interrupted'
              : 'unreachable: upstream never completed';
            for (const id of this.wf.order) {
              if (this.store.node(id).status === 'idle') {
                this.store.setStatus(id, 'skipped', reason);
              }
            }
          }
          break;
        }
        await Promise.race(this.running.values());
      }
    } finally {
      this.store.markFinished(this.signal.aborted);
    }
  }
}
