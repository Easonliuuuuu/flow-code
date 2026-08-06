/**
 * Concurrency accounting for subagents.
 *
 * Subagents draw from the *same* pool as node-level sessions, so the run's
 * configured cap stays one number rather than becoming two budgets that can
 * each be spent in full.
 *
 * The pool is only ever tried, never waited on. A session that spawns a
 * subagent holds a slot while awaiting it, so a subagent made to queue on the
 * same pool would be waiting for a slot its own parent is holding — a
 * deadlock, and a likely one given the cap defaults to 2. Refusing returns
 * immediately and the parent does the work in its own session instead.
 */
export interface SlotPool {
  /** Claim a slot without waiting. Null when none is free. */
  tryAcquire(): (() => void) | null;
}

/**
 * One session's subagent slots. Scoped per session rather than per run so that
 * `dispose` can return everything the session still holds: a spawn that was
 * allowed but never started would otherwise strand a slot for the rest of the
 * run.
 */
export class SubagentScope {
  /** Claimed at spawn time, before the subagent has an id to key on. */
  private pending: Array<() => void> = [];
  private live = new Map<string, () => void>();

  constructor(private readonly pool: SlotPool | undefined) {}

  /**
   * Claim a slot for a spawn about to be allowed. Claimed here rather than at
   * `started` because several spawns can clear the permission check before any
   * of them reports starting, and the check has to be self-consistent.
   */
  tryAcquire(): boolean {
    if (!this.pool) return false;
    const release = this.pool.tryAcquire();
    if (!release) return false;
    this.pending.push(release);
    return true;
  }

  /** Bind the oldest unclaimed slot to the subagent that just started. */
  started(agentId: string): void {
    const release = this.pending.shift();
    if (release) this.live.set(agentId, release);
  }

  /** Return the slot a finished subagent held. */
  stopped(agentId: string): void {
    const release = this.live.get(agentId);
    if (!release) return;
    this.live.delete(agentId);
    release();
  }

  /** Return everything still held. Safe to call twice. */
  dispose(): void {
    for (const release of this.pending.splice(0)) release();
    for (const release of this.live.values()) release();
    this.live.clear();
  }

  /** Slots this session currently holds — pending plus live. */
  get held(): number {
    return this.pending.length + this.live.size;
  }

  /**
   * Subagents that started and have not stopped. Exactly what this session
   * contributed to its node's in-flight count, so ending it can subtract its
   * own share rather than zeroing a counter shared with sibling instances.
   */
  get liveCount(): number {
    return this.live.size;
  }
}
