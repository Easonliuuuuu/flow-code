/**
 * Reading a run from disk instead of driving it — the state side of
 * `flow-code watch`.
 *
 * `FileRunStatePersister` writes the complete run-state document atomically
 * on every mutation, which makes `.flow-code/runs/<runId>.json` a perfectly
 * good broadcast channel: another process (another terminal, another
 * monitor) can follow a run by re-reading that file. Nothing here ever
 * writes — a viewer that could scribble on the run it is watching would be a
 * far worse bug than a viewer that lags a frame.
 */

import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { driverLiveness, isRunDocument, runFilePath, runsDir } from './persist.js';
import type { NodeRunState, RunState } from './types.js';

/**
 * Fallback cadence for the mtime poll. `fs.watch` is the fast path, but it is
 * unreliable across filesystem boundaries — notably WSL's 9p mounts and
 * network shares, which is exactly where "run in one window, watch in
 * another" is most likely to span a shared checkout rather than a local disk.
 */
export const WATCH_POLL_INTERVAL_MS = 400;

/** Debounce for `fs.watch` events: one atomic rename can fire several. */
const WATCH_DEBOUNCE_MS = 30;

/**
 * The state a viewer shows before any run exists. The empty `runId` is what
 * marks it — the UI reads that as "attached to nothing yet" and draws the
 * workflow's shape with every node idle, so the graph is on screen
 * immediately rather than only once a run starts.
 */
export function emptyRunState(repoRoot: string, nodeIds: string[]): RunState {
  const nodes: Record<string, NodeRunState> = {};
  for (const id of nodeIds) nodes[id] = { status: 'idle', denials: 0 };
  return {
    runId: '',
    createdAt: new Date().toISOString(),
    repoRoot,
    pid: 0,
    baseline: null,
    nodes,
    worktrees: [],
    activity: [],
  };
}

/** Whether `state` is a real run rather than the {@link emptyRunState} placeholder. */
export function isAttached(state: RunState): boolean {
  return state.runId.length > 0;
}

/**
 * Path of the most recently *written* run file, or undefined if there are
 * none.
 *
 * Recency is by mtime rather than by the run's `createdAt`, which matters in
 * one case that would otherwise be wrong: `--resume` continues a run under
 * its original id and `createdAt`, so a resumed older run is the live one
 * even though a newer run exists. Whichever file is being written is the one
 * worth watching. It also costs a readdir and a stat each, instead of parsing
 * every run in the repo.
 */
export function newestRunFile(repoRoot: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(runsDir(repoRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const file of files) {
    const path = join(runsDir(repoRoot), file);
    try {
      const { mtimeMs } = statSync(path);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    } catch {
      // Vanished between readdir and stat (a `.tmp` mid-rename): skip it.
    }
  }
  return newest?.path;
}

/** The run a viewer attaches to by default — see {@link newestRunFile}. */
export function latestRunState(repoRoot: string): RunState | undefined {
  const path = newestRunFile(repoRoot);
  if (!path) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunState;
    return isRunDocument(state) ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process driving this run is still around — the difference
 * between a run that is quietly thinking, one whose driver died, and one this
 * machine cannot answer for at all. Defined in `persist.ts` alongside the
 * ownership it reads; re-exported here because every viewer reaches for it
 * through the watch module.
 */
export { driverLiveness, type DriverLiveness } from './persist.js';

/**
 * Runs that look live right now, newest-written first.
 *
 * Only the `limit` most recently written documents are parsed. A run that is
 * live but has not been written more recently than `limit` others is possible
 * in principle and vanishingly rare in practice, and the alternative — parsing
 * every run a repository has ever recorded — is a cost paid on every refresh
 * of a status line for an answer that changes about once a day.
 */
export function liveRuns(repoRoot: string, limit = 8): RunState[] {
  let files: string[];
  try {
    files = readdirSync(runsDir(repoRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const byRecency: Array<{ path: string; mtimeMs: number }> = [];
  for (const file of files) {
    const path = join(runsDir(repoRoot), file);
    try {
      byRecency.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // Vanished between readdir and stat: skip it.
    }
  }
  byRecency.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const live: RunState[] = [];
  for (const { path } of byRecency.slice(0, limit)) {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as RunState;
      if (isRunDocument(state) && state.finishedAt === undefined && driverLiveness(state) === 'live') live.push(state);
    } catch {
      // Unreadable or mid-write: not something to report as live.
    }
  }
  return live;
}

export interface RunStateWatcherOptions {
  repoRoot: string;
  /**
   * Pin to one run. Left unset, the watcher follows whichever run is being
   * written — so a `flow-code run` started after the viewer was already open
   * gets picked up rather than ignored.
   */
  runId?: string;
  onState: (state: RunState) => void;
  pollIntervalMs?: number;
}

/**
 * Follows a run's state file and hands each new version to `onState`.
 *
 * Change detection is stat-gated (mtime + size) and then confirmed against
 * the raw text, so a long activity log isn't re-parsed every tick and an
 * identical rewrite doesn't cause a redraw.
 */
export class RunStateWatcher {
  private readonly opts: RunStateWatcherOptions;
  private fsWatcher: FSWatcher | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private lastPath: string | undefined;
  private lastSignature: string | undefined;
  private lastText: string | undefined;
  private closed = false;

  constructor(opts: RunStateWatcherOptions) {
    this.opts = opts;
  }

  /** Emits the current state (if there is one), then follows changes. */
  start(): void {
    this.check();
    try {
      // Watch the directory, not the file: the atomic tmp-then-rename swaps
      // the inode out from under a file watcher, which then goes deaf.
      this.fsWatcher = watch(runsDir(this.opts.repoRoot), () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.check(), WATCH_DEBOUNCE_MS);
      });
    } catch {
      // No inotify, or the runs dir doesn't exist yet — the poll covers it.
    }
    this.poll = setInterval(() => this.check(), this.opts.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS);
    // Never hold the process open on the viewer's behalf; the UI decides when
    // to exit.
    this.poll.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    this.fsWatcher?.close();
  }

  /** Re-resolves the target run and emits it if anything changed. */
  private check(): void {
    if (this.closed) return;
    const path = this.opts.runId
      ? runFilePath(this.opts.repoRoot, this.opts.runId)
      : newestRunFile(this.opts.repoRoot);
    if (!path) return;

    let signature: string;
    try {
      const stat = statSync(path);
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return;
    }

    // Switching to a different run always emits, even in the unlikely case
    // that the new file's size and mtime match the old one's.
    const switched = path !== this.lastPath;
    if (!switched && signature === this.lastSignature) return;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    if (!switched && text === this.lastText) {
      this.lastSignature = signature;
      return;
    }

    let state: RunState;
    try {
      state = JSON.parse(text) as RunState;
    } catch {
      // Caught mid-write, or a malformed file. Leave the signature alone so
      // the next tick retries instead of treating this version as seen.
      return;
    }

    this.lastPath = path;
    this.lastSignature = signature;
    this.lastText = text;
    this.opts.onState(state);
  }
}
