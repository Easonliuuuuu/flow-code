/**
 * Writing run-state on behalf of an agent flow-code is not running.
 *
 * The engine's writer (`RunStateStore`) is built for a process that holds the
 * run open from start to finish: it keeps the document in memory, mutates it,
 * and persists after each change. A reporting surface is the opposite shape —
 * each report arrives in its own short-lived process (a CLI invocation) or on
 * its own turn (an MCP call), with nothing carried between them. So every
 * operation here is a read-modify-write against the document on disk, and the
 * document is the only thing that persists.
 *
 * Both surfaces — `flow-code node …` and the MCP tools — call exactly these
 * functions. That is what makes "the same transitions produce the same
 * run-state either way" structural rather than a promise to keep them aligned.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { recordBaseline } from '../git/ops.js';
import {
  driverLiveness,
  FileRunStatePersister,
  readRunState,
  runFilePath,
  unattributedOwner,
} from '../runstate/persist.js';
import { enforcementOf, type ReportingSurface } from '../runstate/tier.js';
import { enforcementLive } from './enforce.js';
import type { AttemptRecord, NodeRunState, RunState } from '../runstate/types.js';
import { loadWorkflow, WorkflowValidationError, type Workflow } from '../workflow/load.js';
import { recordGraph, RecordedGraphError, rehydrateGraph } from '../workflow/record.js';
import { validateTransition, type AcceptedTransition, type ReportedTransition } from './validate.js';

/**
 * A report that was refused. Carries only a message: everything a reporting
 * agent can do about a refusal is contained in what the refusal says, and both
 * surfaces render it the same way for that reason.
 */
export class GuestReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestReportError';
  }
}

/** Where a reported run's document lives, and what is in it right now. */
function loadRun(repoRoot: string, runId: string): RunState {
  const path = runFilePath(repoRoot, runId);
  if (!existsSync(path)) {
    throw new GuestReportError(`no run \`${runId}\` in this repository`);
  }
  try {
    return readRunState(path);
  } catch {
    throw new GuestReportError(`run \`${runId}\` could not be read as a run document`);
  }
}

/**
 * Refuse to touch a run something else is actively driving.
 *
 * The persistence layer refuses this too, and would catch it even if this
 * check were deleted — but it refuses in the language of writers and tokens.
 * A reporting agent needs to be told the thing it can act on: this run belongs
 * to a `flow-code run` that is still going, so report against a run of your
 * own instead of trying to join that one.
 */
function assertNotDriven(state: RunState): void {
  if (state.finishedAt !== undefined) return;
  if (driverLiveness(state) !== 'live') return;
  throw new GuestReportError(
    `run ${state.runId.slice(0, 8)} is being driven by \`flow-code run\` (pid ${state.owner?.pid}) — ` +
      `reports are refused while it owns the run. Open your own run with \`flow-code node open\`.`,
  );
}

/** The graph the run recorded, rebuilt — never the current workflow file. */
function workflowOf(state: RunState, repoRoot: string): Workflow {
  if (!state.graph) {
    throw new GuestReportError(
      `run ${state.runId.slice(0, 8)} recorded no graph — nothing can be validated against it`,
    );
  }
  try {
    return rehydrateGraph(state.graph, { repoRoot });
  } catch (err) {
    if (err instanceof RecordedGraphError) throw new GuestReportError(err.message);
    throw err;
  }
}

/**
 * Persist a modified document, claiming write ownership as we go.
 *
 * Claiming on every write is right for a surface with no continuity: this
 * process cannot have held ownership from last time, because last time was a
 * different process. What stops that from becoming a way to trample a live
 * engine run is {@link assertNotDriven} above and the persister's own check
 * below it — the claim is only ever granted over a run nobody is driving.
 */
function persist(repoRoot: string, state: RunState): void {
  const claimed: RunState = { ...state, owner: unattributedOwner(), pid: 0 };
  new FileRunStatePersister(repoRoot).persist(claimed);
}

export interface OpenRunOptions {
  surface: ReportingSurface;
  /** Which declared graph to open, for a workflow file that declares several. */
  graph?: string;
}

export interface OpenedRun {
  runId: string;
  /** Node ids in execution order — what the agent is expected to walk. */
  order: string[];
  workflow: Workflow;
}

/**
 * Open a reported run against the project's workflow.
 *
 * Always a new run document, never a join: an engine-driven run already in
 * progress belongs to the engine, and merging an outside agent's claims into
 * it would produce a run whose history is partly enforced and partly asserted
 * with no way to tell which parts are which.
 */
export async function openGuestRun(repoRoot: string, opts: OpenRunOptions): Promise<OpenedRun> {
  let workflow: Workflow;
  try {
    workflow = loadWorkflow(repoRoot, opts.graph !== undefined ? { graph: opts.graph } : {});
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      throw new GuestReportError(
        `the workflow file is invalid:\n${err.problems.map((p) => `  - ${p}`).join('\n')}`,
      );
    }
    throw err;
  }

  const nodes: Record<string, NodeRunState> = {};
  for (const node of workflow.nodes) nodes[node.id] = { status: 'idle', denials: 0 };

  // Captured against the working tree as it stands rather than against HEAD:
  // a run opened from inside somebody's session starts on whatever they had
  // going, and refusing a dirty tree — which `flow-code run` does, because it
  // is about to make changes of its own — would refuse most real sessions.
  // Best-effort: a repository this cannot read is still worth reporting a
  // graph for, and the only thing a missing baseline costs is reconciliation.
  let baseline = null;
  try {
    baseline = await recordBaseline(repoRoot, true);
  } catch {
    baseline = null;
  }

  const state: RunState = {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    repoRoot,
    pid: 0,
    owner: unattributedOwner(),
    // Verified, never assumed from an installed plugin: hooks can be turned
    // off after installation, and a settings file states an intention rather
    // than a fact. `enforcementLive` reads evidence the hook itself wrote.
    enforcement: enforcementOf(enforcementLive(repoRoot) ? 'hooks' : 'reported', opts.surface),
    baseline,
    graph: recordGraph(workflow, opts.graph),
    nodes,
    worktrees: [],
    activity: [],
  };
  persist(repoRoot, state);
  return { runId: state.runId, order: [...workflow.order], workflow };
}

/**
 * Apply one reported transition, or refuse it with a reason.
 *
 * Validation happens before anything is written and the write happens in one
 * atomic replacement, so a refused report leaves the document byte-identical —
 * which is the property the whole surface rests on.
 */
export function reportTransition(
  repoRoot: string,
  runId: string,
  reported: ReportedTransition,
): AcceptedTransition {
  const state = loadRun(repoRoot, runId);
  assertNotDriven(state);
  if (state.finishedAt !== undefined) {
    throw new GuestReportError(`run ${runId.slice(0, 8)} is already closed`);
  }
  const workflow = workflowOf(state, repoRoot);

  const result = validateTransition(workflow, state, reported);
  if (!result.ok) throw new GuestReportError(result.reason);

  persist(repoRoot, withTierCheck(repoRoot, applyTransition(state, result.accepted)));
  return result.accepted;
}

/**
 * Re-check, on every transition, that a run claiming enforcement still has it.
 *
 * Verifying once at open would leave the claim standing for the rest of a run
 * in which the user disabled hooks, uninstalled the plugin, or moved to a
 * session without it. Transitions are the natural place to look: they are the
 * only moments flow-code is given control, they happen often enough to catch a
 * change quickly, and they cost a stat that the write about to happen dwarfs.
 *
 * One-way, deliberately. A run never upgrades back: work already done under
 * no enforcement is not retrospectively enforced by the layer coming back.
 */
function withTierCheck(repoRoot: string, state: RunState): RunState {
  const enforcement = state.enforcement;
  if (!enforcement || enforcement.tier !== 'hooks') return state;
  if (enforcementLive(repoRoot)) return state;
  return {
    ...state,
    enforcement: {
      ...enforcement,
      downgrades: [
        ...(enforcement.downgrades ?? []),
        {
          from: 'hooks',
          to: 'reported',
          at: new Date().toISOString(),
          reason: "flow-code's enforcement layer stopped running in this session",
        },
      ],
    },
  };
}

/**
 * The accepted transition as a change to the document.
 *
 * Deliberately narrow: status, its detail, the timestamps that bracket a
 * node's wall-clock time, and output. A reported run has no activity log and
 * no token counts, and inventing empty ones would put a run's absent
 * guarantees back into the shape of the data — the thing the tier field exists
 * to keep out of it.
 */
function applyTransition(state: RunState, accepted: AcceptedTransition): RunState {
  const previous = state.nodes[accepted.nodeId]!;
  const now = new Date().toISOString();
  const terminal = accepted.status === 'done' || accepted.status === 'error';

  const next: NodeRunState = { ...previous, status: accepted.status };
  if (accepted.status === 'running') {
    // Re-entering a node that had finished — a retry, or a loop-back the agent
    // walked — is a fresh attempt, and its clock starts again. The attempt it
    // is replacing already recorded its own ending.
    next.startedAt = now;
    delete next.endedAt;
    if (previous.status === 'error' || previous.status === 'done') {
      next.attempt = (previous.attempt ?? 1) + 1;
      next.priorAttempts = priorAttemptsAfter(previous, now);
      delete next.output;
    }
  }
  if (terminal) next.endedAt = now;
  if (accepted.detail !== undefined) next.statusDetail = accepted.detail;
  else delete next.statusDetail;
  if (accepted.output !== undefined) next.output = accepted.output;
  if (accepted.gateDecision !== undefined) next.gateDecision = accepted.gateDecision;

  const nodes = { ...state.nodes, [accepted.nodeId]: next };
  for (const id of accepted.reset ?? []) nodes[id] = resetForAnotherAttempt(state.nodes[id]!, now);
  return { ...state, nodes };
}

/** The terminal outcome of the attempt being replaced, appended to the node's history. */
function priorAttemptsAfter(previous: NodeRunState, at: string): AttemptRecord[] {
  return [
    ...(previous.priorAttempts ?? []),
    {
      status: previous.status,
      ...(previous.statusDetail !== undefined ? { detail: previous.statusDetail } : {}),
      endedAt: previous.endedAt ?? at,
    },
  ];
}

/**
 * Return a node the loop-back re-runs to `idle`.
 *
 * Results of the finished attempt are cleared — a stale output would read as
 * this attempt's — while its outcome is kept, which is the same bargain
 * `RunStateStore.resetNode` strikes for an engine-driven run. A node that
 * never ran is left exactly as it is: there is no attempt to record.
 */
function resetForAnotherAttempt(node: NodeRunState, at: string): NodeRunState {
  if (node.status === 'idle') return node;
  const { output: _o, statusDetail: _d, startedAt: _s, endedAt: _e, skipReason: _k, ...rest } = node;
  return {
    ...rest,
    status: 'idle',
    attempt: (node.attempt ?? 1) + 1,
    priorAttempts: priorAttemptsAfter(node, at),
  };
}

/**
 * Close a reported run.
 *
 * `interrupted` is the difference between a run that ended and one a viewer
 * should keep treating as resumable, and a reporting agent is the only thing
 * that knows which happened.
 */
export function closeGuestRun(repoRoot: string, runId: string, interrupted = false): RunState {
  const state = loadRun(repoRoot, runId);
  assertNotDriven(state);
  if (state.finishedAt !== undefined) return state;
  const closed: RunState = { ...state, finishedAt: new Date().toISOString(), interrupted };
  persist(repoRoot, closed);
  return closed;
}

/**
 * The reported run a surface should target when the agent does not name one:
 * the most recently opened run that is still open. Undefined when there is
 * none, which callers turn into "open one first" rather than opening one
 * implicitly — an agent that reports a transition against a run it never
 * opened has lost track of where it is, and papering over that would hide it.
 */
export function currentGuestRun(repoRoot: string, states: RunState[]): RunState | undefined {
  return states
    .filter((s) => s.finishedAt === undefined && isReportedRun(s))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * A run driven from outside flow-code's engine — whatever enforcement it
 * turned out to have.
 *
 * Matching on "not engine" rather than on the `reported` tier specifically:
 * the tier records how much was in force, and a run that opened with the
 * enforcement layer live is still the same run this session is walking. An
 * earlier version tested for `reported` and so lost track of every run the
 * moment enforcement started working, which is the sort of bug that only
 * appears once both halves exist.
 */
function isReportedRun(state: RunState): boolean {
  return state.enforcement !== undefined && state.enforcement.tier !== 'engine';
}
