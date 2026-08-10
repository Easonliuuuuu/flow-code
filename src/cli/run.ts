import { existsSync } from 'node:fs';
import { Engine } from '../engine/engine.js';
import { preflight, PreflightError } from '../engine/preflight.js';
import { builtinExecutors, SdkSessionRunner } from '../executors/index.js';
import { ensureGitExclude } from '../git/exclude.js';
import { git, recordBaseline, removeWorktree } from '../git/ops.js';
import { confirm } from '../init/prompts.js';
import { selectFromList } from '../init/SelectList.js';
import {
  FileRunStatePersister,
  findInterruptedRun,
  findLatestInterruptedRun,
} from '../runstate/persist.js';
import { RunStateStore } from '../runstate/store.js';
import type { RunState } from '../runstate/types.js';
import { runUi, UiInteractionPorts } from '../ui/index.js';
import { declaredGraphs, type Workflow } from '../workflow/load.js';
import { RecordedGraphError, recordGraph, rehydrateGraph } from '../workflow/record.js';
import { findOrphanedWorktrees, removeOrphanedWorktrees } from '../worktrees/reconcile.js';
import { splashEnabled } from './args.js';
import { fail, loadWorkflowOrFail, repoRootFromCwd } from './context.js';
import { buildRunner, resolveProvider } from './provider.js';

export interface ResumeArg {
  resuming: boolean;
  /** The explicit run id, when `--resume` was given one rather than a bare flag. */
  runId?: string;
}

/**
 * `--resume`/`-r` takes an optional run id. The value after it is only a run
 * id when it exists and isn't another flag, so `run --resume --allow-dirty`
 * resumes the most recent run rather than looking for one called
 * `--allow-dirty`.
 */
export function parseResumeArg(args: string[]): ResumeArg {
  const idx = args.findIndex((a) => a === '--resume' || a === '-r');
  if (idx < 0) return { resuming: false };
  const next = args[idx + 1];
  return next !== undefined && !next.startsWith('-') ? { resuming: true, runId: next } : { resuming: true };
}

/**
 * `--graph <name>` selects which declared graph a fresh run executes. Not
 * meaningful with `--resume` — a resumed run continues whichever graph it
 * already recorded.
 */
export function parseGraphArg(args: string[]): string | undefined {
  const idx = args.findIndex((a) => a === '--graph');
  if (idx < 0) return undefined;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('-')) {
    fail('--graph requires a graph name.');
  }
  return next;
}

/**
 * The interrupted run `--resume` targets, or a failure explaining why it
 * can't be resumed: no such run, one that predates recorded graphs, or a run
 * with no baseline to diff against. Resuming rehydrates the graph the run
 * itself recorded (see `cmdRun`), not the current `workflow.yaml` — so this
 * no longer needs the workflow loaded at all to decide resumability.
 */
export function resolveResumeState(repoRoot: string, runId?: string): RunState {
  const resumeState = runId ? findInterruptedRun(repoRoot, runId) : findLatestInterruptedRun(repoRoot);
  if (!resumeState) {
    fail(
      runId
        ? `no interrupted run \`${runId}\` found to resume.`
        : 'no interrupted run found to resume — start a new one with `flow-code run`.',
    );
  }
  if (!resumeState.graph) {
    fail(`run ${resumeState.runId.slice(0, 8)} predates recorded graphs — cannot resume.`);
  }
  if (!resumeState.baseline) {
    fail(`run ${resumeState.runId.slice(0, 8)} has no recorded baseline — cannot resume.`);
  }
  return resumeState;
}

/** The shape of `selectFromList` `resolveGraphSelection` needs — narrowed so a test can inject a fake without a real TTY. */
type GraphPicker = (
  items: { label: string; value: string }[],
  opts: { prompt: string },
) => Promise<string | undefined>;

/**
 * Resolves which declared graph a fresh run executes, before any node
 * starts: an explicit `--graph`, the sole declared name (no prompt), an
 * interactive pick, or a failure naming what the file declares. `undefined`
 * for a flat-form file (nothing to select) or one that fails to even parse —
 * the subsequent `loadWorkflowOrFail` surfaces that failure properly instead
 * of this duplicating it.
 */
export async function resolveGraphSelection(
  repoRoot: string,
  explicit: string | undefined,
  deps: { pick?: GraphPicker } = {},
): Promise<string | undefined> {
  const pick = deps.pick ?? selectFromList;
  const declared = declaredGraphs(repoRoot);
  if (declared === null) return undefined;
  const names = declared.map((g) => g.name);
  if (explicit !== undefined) {
    if (!names.includes(explicit)) {
      fail(`graph \`${explicit}\` is not declared — this file declares: ${names.join(', ')}`);
    }
    return explicit;
  }
  if (declared.length === 1) return declared[0]!.name;
  if (!process.stdin.isTTY) {
    fail(`this file declares more than one graph (${names.join(', ')}) — pass --graph <name>.`);
  }
  const chosen = await pick(
    declared.map((g) => ({
      label: g.description ? `${g.name} — ${g.description}` : g.name,
      value: g.name,
    })),
    { prompt: 'Which graph should this run execute?' },
  );
  if (chosen === undefined) fail('no graph selected.');
  return chosen;
}

/**
 * Any node not already `done` restarts from scratch; clear its old worktree
 * (if any) first so the retry doesn't collide with the same dir/branch the
 * interrupted attempt used. Mutates `resumeState.worktrees` in place, marking
 * what it cleared as removed.
 */
export async function resetInterruptedWorktrees(repoRoot: string, resumeState: RunState): Promise<void> {
  const resetNodeIds = new Set(
    Object.entries(resumeState.nodes)
      .filter(([, n]) => n.status !== 'done')
      .map(([id]) => id),
  );
  for (const wt of resumeState.worktrees) {
    if (wt.removed || !resetNodeIds.has(wt.nodeId)) continue;
    if (existsSync(wt.dir)) {
      try {
        await removeWorktree(repoRoot, wt.dir);
      } catch {
        // best-effort — addWorktree will surface a real problem below
      }
    }
    // addWorktree re-creates this branch with `-b`, which fails outright
    // if it already exists from the interrupted attempt.
    try {
      await git(['branch', '-D', wt.branch], repoRoot);
    } catch {
      // never existed, or already gone — fine either way
    }
    wt.removed = true;
  }
}

/** Node count by final status, e.g. `2 done, 1 error` — shared by the closing summary and `flow-code runs`. */
export function tallyNodeStatuses(nodes: RunState['nodes']): string {
  const counts = Object.values(nodes).reduce<Record<string, number>>(
    (acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }),
    {},
  );
  return Object.entries(counts)
    .map(([s, c]) => `${c} ${s}`)
    .join(', ');
}

/** The closing one-liner: how the run ended, and a tally of nodes by final status. */
export function formatRunSummary(runId: string, nodes: RunState['nodes'], interrupted: boolean): string {
  return (
    `flow-code: run ${runId.slice(0, 8)} ${interrupted ? 'interrupted' : 'finished'} — ` +
    tallyNodeStatuses(nodes)
  );
}

/** 130 for an interrupt (the shell's SIGINT convention), 1 if any node errored, else 0. */
export function runExitCode(nodes: RunState['nodes'], interrupted: boolean): number {
  if (interrupted) return 130;
  return Object.values(nodes).some((n) => n.status === 'error') ? 1 : 0;
}

export async function cmdRun(args: string[]): Promise<void> {
  const allowDirty = args.includes('--allow-dirty');
  const splash = splashEnabled(args, process.env);
  const { resuming, runId: resumeRunId } = parseResumeArg(args);
  const explicitGraph = parseGraphArg(args);
  const repoRoot = await repoRootFromCwd();

  let workflow: Workflow;
  let resumeState: RunState | undefined;
  // Which named graph this run executes, when the file declares more than
  // one — resolved once, up front, and carried through to `recordGraph` and
  // the run header rather than re-derived later.
  let graphName: string | undefined;

  if (resuming) {
    resumeState = resolveResumeState(repoRoot, resumeRunId);
    try {
      workflow = rehydrateGraph(resumeState.graph!, { repoRoot });
    } catch (err) {
      if (err instanceof RecordedGraphError) fail(err.message);
      throw err;
    }
    graphName = resumeState.graph!.selected;
    console.log(
      `flow-code: resuming run ${resumeState.runId.slice(0, 8)} — continuing its recorded graph` +
        `${graphName ? ` (\`${graphName}\`)` : ''}, not the current workflow file.`,
    );
  } else {
    graphName = await resolveGraphSelection(repoRoot, explicitGraph);
    workflow = loadWorkflowOrFail(repoRoot, graphName !== undefined ? { graph: graphName } : {});
  }

  // Captured before the fallback below can overwrite it, so the run UI can
  // still tell a node that inherits the workflow's own `settings.model` apart
  // from one that's only ever seeing the provider default plugged into it.
  const workflowSettingsModel = workflow.settings.model;
  const resolved = await resolveProvider(repoRoot, workflow);
  if (resolved?.model && !workflow.settings.model) {
    workflow.settings.model = resolved.model;
  }

  if (!resuming) {
    // Reconcile orphans from crashed runs before starting a new one. Skipped
    // while resuming: this run's own retained worktrees would show up here
    // too (nothing distinguishes them from a truly abandoned run) and must
    // not be offered up for deletion.
    const orphans = findOrphanedWorktrees(repoRoot);
    if (orphans.length > 0) {
      console.log(`flow-code: ${orphans.length} orphaned worktree(s) found from a previous run.`);
      if (await confirm('Clean them up before starting?')) {
        await removeOrphanedWorktrees(repoRoot, orphans);
      } else {
        console.log('flow-code: continuing; run `flow-code doctor` to clean up later.');
      }
    }
  }

  try {
    // A resumed tree is expected to carry the interrupted work's uncommitted
    // changes — the normal dirty-tree refusal doesn't apply here.
    await preflight(workflow, repoRoot, {
      allowDirty: allowDirty || resuming,
      ...(resolved ? { provider: resolved.provider } : {}),
      onWarning: (message) => console.warn(`flow-code: ${message}`),
    });
  } catch (err) {
    if (err instanceof PreflightError) fail(err.message);
    throw err;
  }

  ensureGitExclude(repoRoot);

  let baseline;
  let store: RunStateStore;
  if (resumeState) {
    baseline = resumeState.baseline!;
    await resetInterruptedWorktrees(repoRoot, resumeState);
    store = new RunStateStore({
      repoRoot,
      graph: recordGraph(workflow, graphName),
      resumeFrom: resumeState,
    });
  } else {
    baseline = await recordBaseline(repoRoot, allowDirty);
    store = new RunStateStore({ repoRoot, graph: recordGraph(workflow, graphName) });
  }
  store.attachPersister(new FileRunStatePersister(repoRoot));
  store.setBaseline(baseline);

  const abortController = new AbortController();
  const ports = new UiInteractionPorts(abortController.signal);
  const engine = new Engine({
    workflow,
    store,
    repoRoot,
    baseline,
    ports,
    sessions: resolved ? buildRunner(resolved.provider) : new SdkSessionRunner(),
    executors: builtinExecutors,
    signal: abortController.signal,
  });

  // ctrl+c (via the UI) or a real SIGINT/SIGTERM (piped stdin, `kill`, a
  // second ctrl+c once the terminal has left raw mode) both land here.
  // First call aborts the run and gives in-flight nodes a chance to unwind
  // cleanly; a second forces an immediate exit in case something is stuck.
  let interruptCount = 0;
  const triggerInterrupt = (): void => {
    interruptCount += 1;
    if (interruptCount > 1) {
      console.error('\nflow-code: forcing exit.');
      process.exit(130);
    }
    console.error(
      '\nflow-code: interrupting — finishing cleanly (press ctrl+c again to force quit)…',
    );
    abortController.abort();
    // Safety net: if some code path fails to respect the signal and hangs,
    // don't leave the terminal stuck. unref so it never delays a clean exit.
    setTimeout(() => {
      console.error('flow-code: cleanup took too long — forcing exit.');
      process.exit(130);
    }, 10_000).unref();
  };
  process.on('SIGINT', triggerInterrupt);
  process.on('SIGTERM', triggerInterrupt);

  const enginePromise = engine.run().then(async () => {
    // The run reached a terminal state: retained (converged) worktrees can
    // go now; their branches keep the work reachable.
    for (const wt of store.snapshot().worktrees) {
      if (!wt.removed && existsSync(wt.dir)) {
        try {
          await removeWorktree(repoRoot, wt.dir);
          store.updateWorktree(wt.dir, { removed: true });
        } catch {
          // leave it for doctor
        }
      }
    }
  });

  await runUi({
    workflow,
    store,
    ports,
    repoRoot,
    onInterrupt: triggerInterrupt,
    splash,
    modelContext: {
      providerId: resolved?.provider,
      providerDefaultModel: resolved?.model,
      workflowSettingsModel,
    },
  });
  await enginePromise;
  process.off('SIGINT', triggerInterrupt);
  process.off('SIGTERM', triggerInterrupt);

  const nodes = store.snapshot().nodes;
  const interrupted = abortController.signal.aborted;
  console.log(formatRunSummary(store.runId, nodes, interrupted));
  process.exit(runExitCode(nodes, interrupted));
}
