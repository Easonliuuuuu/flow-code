import { randomUUID } from 'node:crypto';
/**
 * Central run-state store. The engine and harness write into it; the UI (and
 * the persister) subscribe to it. It has no dependency on the rendering
 * layer, so runs record identical state with no UI attached.
 */
export class RunStateStore {
    state;
    listeners = new Set();
    /** In-memory only: live streamed output per node, for the detail view. */
    liveOutput = new Map();
    persister;
    constructor(opts) {
        const nodes = {};
        for (const id of opts.nodeIds) {
            const prior = opts.resumeFrom?.nodes[id];
            if (!prior) {
                nodes[id] = { status: 'idle', denials: 0 };
            }
            else if (prior.status === 'done') {
                nodes[id] = prior;
            }
            else {
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
    attachPersister(persister) {
        this.persister = persister;
        this.persister.persist(this.state);
    }
    get runId() {
        return this.state.runId;
    }
    snapshot() {
        return this.state;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    commit() {
        this.state = { ...this.state };
        this.persister?.persist(this.state);
        for (const l of this.listeners)
            l(this.state);
    }
    node(id) {
        const node = this.state.nodes[id];
        if (!node)
            throw new Error(`unknown node in run-state: ${id}`);
        return node;
    }
    setBaseline(baseline) {
        this.state.baseline = baseline;
        this.commit();
    }
    setStatus(nodeId, status, detail) {
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
    /**
     * Which attempt a node is on, counting from 1. Run-state written before
     * loop-backs existed has no counter, and reads as a first attempt.
     */
    attemptOf(nodeId) {
        return this.node(nodeId).attempt ?? 1;
    }
    /**
     * Return a node to `idle` for another attempt, as a loop-back does. Results
     * of the finished attempt are cleared — a stale output would otherwise look
     * like this attempt's — while its outcome is kept in `priorAttempts`. The
     * activity log is append-only and is never cleared: it is the record of what
     * actually ran, across every attempt.
     */
    resetNode(nodeId) {
        const node = this.node(nodeId);
        const prior = {
            status: node.status,
            ...(node.statusDetail !== undefined ? { detail: node.statusDetail } : {}),
            endedAt: new Date().toISOString(),
        };
        const { output: _output, statusDetail: _statusDetail, ...rest } = node;
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
    setOutput(nodeId, output) {
        const node = this.node(nodeId);
        this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, output } };
        this.commit();
    }
    setWorkingDir(nodeId, workingDir) {
        const node = this.node(nodeId);
        this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, workingDir } };
        this.commit();
    }
    /** Append an activity entry; returns it for later completion. */
    appendActivity(entry) {
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
    completeActivity(toolUseId, result) {
        let changed = false;
        this.state.activity = this.state.activity.map((e) => {
            if (e.toolUseId !== toolUseId || e.durationMs !== undefined)
                return e;
            changed = true;
            return { ...e, ...result };
        });
        if (changed)
            this.commit();
    }
    activityFor(nodeId) {
        return this.state.activity.filter((e) => e.nodeId === nodeId);
    }
    addWorktree(record) {
        this.state.worktrees = [...this.state.worktrees, record];
        this.commit();
    }
    updateWorktree(dir, patch) {
        this.state.worktrees = this.state.worktrees.map((w) => w.dir === dir ? { ...w, ...patch } : w);
        this.commit();
    }
    appendLiveOutput(nodeId, text) {
        const prev = this.liveOutput.get(nodeId) ?? '';
        // Keep a bounded tail so long sessions don't grow memory without limit.
        const next = (prev + text).slice(-64_000);
        this.liveOutput.set(nodeId, next);
        this.commit();
    }
    liveOutputFor(nodeId) {
        return this.liveOutput.get(nodeId) ?? '';
    }
    appendDiscussMessage(nodeId, entry) {
        const node = this.node(nodeId);
        const discussTranscript = [...(node.discussTranscript ?? []), entry];
        this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, discussTranscript } };
        this.commit();
    }
    setSessionId(nodeId, sessionId) {
        const node = this.node(nodeId);
        this.state.nodes = { ...this.state.nodes, [nodeId]: { ...node, sessionId } };
        this.commit();
    }
    markFinished(interrupted = false) {
        this.state.finishedAt = new Date().toISOString();
        this.state.interrupted = interrupted;
        this.commit();
    }
    allTerminal() {
        return Object.values(this.state.nodes).every((n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped');
    }
}
//# sourceMappingURL=store.js.map