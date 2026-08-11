import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorePersister } from './store.js';
import type { RunOwner, RunState } from './types.js';

export function runsDir(repoRoot: string): string {
  return join(repoRoot, '.flow-code', 'runs');
}

export function runFilePath(repoRoot: string, runId: string): string {
  return join(runsDir(repoRoot), `${runId}.json`);
}

/** Thrown when a process tries to write a run document that belongs to someone else. */
export class RunOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunOwnershipError';
  }
}

/** The identity this process writes into any run it owns. */
export function newOwner(): RunOwner {
  return { pid: process.pid, host: hostname(), token: randomUUID(), claimedAt: new Date().toISOString() };
}

/**
 * Ownership for a run nothing in this process is driving.
 *
 * A reported run is walked by an agent session flow-code did not start and
 * cannot see; the process that writes each transition is a short-lived
 * reporter that exits immediately afterwards. Recording that reporter's pid
 * would make the run read as abandoned between every pair of reports, and
 * recording a long-lived server's pid would claim it was driving a run it is
 * only relaying. Neither is true, so no pid is recorded at all — `pid: 0`
 * reads back as {@link driverLiveness} `unknown`, which is exactly what a
 * reader can honestly conclude about a session on the other side of a wall.
 *
 * The token is still real: it is what makes the *write* ownable even when the
 * driver is not identifiable.
 */
export function unattributedOwner(): RunOwner {
  return { pid: 0, host: hostname(), token: randomUUID(), claimedAt: new Date().toISOString() };
}

/**
 * What a reader can say about the process driving a run.
 *
 * `unknown` is not a failure to compute — it is the correct answer whenever a
 * pid cannot be attributed: a document written on another machine (a shared
 * checkout), or one written before ownership was recorded at all. Collapsing
 * it into `dead` is what would let a viewer declare a live run abandoned, and
 * what would let worktree reclamation delete a running run's tree.
 *
 * One case stays wrong on purpose: a pid recycled by an unrelated process on
 * this machine reads as `live`. Narrowing it needs either a periodic write
 * (which makes a slow node indistinguishable from a dead driver whenever the
 * interval is tuned wrong — a Discuss node sits silent for as long as the user
 * takes to reply) or reading process start times out of `/proc` and `ps`, a
 * platform dependency this module does not otherwise have. Both were weighed
 * and rejected in `add-run-state-ownership`'s design; the residual case is
 * rarer than the failures either fix introduces.
 */
export type DriverLiveness = 'live' | 'dead' | 'unknown';

export function driverLiveness(state: RunState): DriverLiveness {
  const owner = state.owner;
  if (!owner || owner.pid <= 0) return 'unknown';
  if (owner.host !== hostname()) return 'unknown';
  return pidAlive(owner.pid) ? 'live' : 'dead';
}

/** Stat signature used to notice that something else wrote the file since we did. */
function signatureOf(path: string): string | undefined {
  try {
    const { mtimeMs, size } = statSync(path);
    return `${mtimeMs}:${size}`;
  } catch {
    return undefined;
  }
}

/**
 * Writes the full run-state synchronously on every change (atomic
 * tmp-then-rename), so activity entries written before a crash survive it.
 *
 * The rename is what makes a crash mid-write harmless: readers only ever see
 * the previous complete document or the next one, never a half-written file.
 * Simplifying this to a direct `writeFileSync` on the published path would
 * reintroduce torn documents, which is why a test asserts the property rather
 * than trusting the comment.
 *
 * Writes are also gated on ownership. The common case costs one `stat`: if the
 * file is exactly as we last left it, nobody else has written and it is still
 * ours. Only when that signature has moved is a read-and-parse worth doing,
 * and only then are owner tokens compared.
 */
export class FileRunStatePersister implements StorePersister {
  /** Signature of our own last write, or undefined before we have written. */
  private lastWritten: string | undefined;

  constructor(private readonly repoRoot: string) {
    mkdirSync(runsDir(repoRoot), { recursive: true });
  }

  persist(state: RunState): void {
    const path = runFilePath(this.repoRoot, state.runId);
    this.assertOwned(path, state);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
    this.lastWritten = signatureOf(path);
  }

  private assertOwned(path: string, state: RunState): void {
    const signature = signatureOf(path);
    // Nothing on disk: this run is ours to create.
    if (signature === undefined) return;
    // Untouched since our last write: still ours, and no read needed.
    if (signature === this.lastWritten) return;

    let disk: RunState | undefined;
    try {
      disk = readRunState(path);
    } catch {
      // Unreadable or not a run document. We hold the id; overwriting it is
      // the only way the run continues, and there is no owner to respect.
      return;
    }
    const diskToken = disk.owner?.token;
    if (diskToken === undefined || diskToken === state.owner?.token) return;

    if (this.lastWritten !== undefined) {
      throw new RunOwnershipError(
        `run ${state.runId} was taken over by another process (pid ${disk.owner?.pid} on ${disk.owner?.host}) — refusing to write over it`,
      );
    }
    // We have not written yet, so this is a claim rather than a conflict.
    // Taking over a run nobody is driving is exactly what `--resume` does;
    // taking one that is still being driven is what must never happen. A run
    // that recorded an ending is not being driven, whatever its pid says.
    if (disk.finishedAt === undefined && driverLiveness(disk) === 'live') {
      throw new RunOwnershipError(
        `run ${state.runId} is already being driven by pid ${disk.owner?.pid} — refusing to write over it`,
      );
    }
  }
}

export function readRunState(path: string): RunState {
  return JSON.parse(readFileSync(path, 'utf8')) as RunState;
}

/**
 * Whether a parsed document is actually a run.
 *
 * Every reader here globs `*.json` under `runs/`, which quietly assumed that
 * nothing else would ever be written there. That assumption broke the moment
 * something was: a file with no `nodes` was picked up as a run with no nodes,
 * and the viewer attached to it in preference to the real one. Cheap to check,
 * and it makes the readers robust against the next thing that lands nearby.
 */
export function isRunDocument(value: unknown): value is RunState {
  const doc = value as RunState | undefined;
  return typeof doc?.runId === 'string' && typeof doc.nodes === 'object' && doc.nodes !== null;
}

/**
 * Whether `pid` still belongs to a live process on *this* machine.
 *
 * Signal 0 checks for existence without delivering anything; EPERM means the
 * pid exists under another user, which still counts. Callers should prefer
 * {@link driverLiveness}, which knows whether the pid is even ours to check.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function listRunStates(repoRoot: string): RunState[] {
  let files: string[];
  try {
    files = readdirSync(runsDir(repoRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const states: RunState[] = [];
  for (const f of files) {
    try {
      const state = readRunState(join(runsDir(repoRoot), f));
      if (isRunDocument(state)) states.push(state);
    } catch {
      // Unreadable run file: skip rather than fail the whole listing.
    }
  }
  return states;
}

/** Most recently created run that ended via interrupt (ctrl+c/SIGTERM), if any — what `--resume` (no id) targets. */
export function findLatestInterruptedRun(repoRoot: string): RunState | undefined {
  return listRunStates(repoRoot)
    .filter((s) => s.interrupted === true)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** A specific run by id, only if it ended via interrupt — what `--resume <runId>` targets. */
export function findInterruptedRun(repoRoot: string, runId: string): RunState | undefined {
  try {
    const state = readRunState(runFilePath(repoRoot, runId));
    return state.interrupted === true ? state : undefined;
  } catch {
    return undefined;
  }
}
