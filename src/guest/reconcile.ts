/**
 * Checking a run's claims against the repository.
 *
 * Validation (`validate.ts`) can tell whether a reported transition was *legal*
 * — whether the graph permits it, in that order, with output of that shape. It
 * cannot tell whether the work happened. An agent that reports `implement`
 * complete without writing a line produces a run that is internally consistent
 * and completely false, and enforcement does not help: narrowing what a session
 * may *do* says nothing about what it *says* it did.
 *
 * The tree is the one witness that does not depend on the agent's honesty. So
 * this compares what each node claimed against what the repository actually
 * shows, using the baseline the run recorded when it opened.
 *
 * It is advisory by construction. It reports disagreement and never resolves
 * it: the tree cannot say *why* a claim is unsupported — a node may have been
 * legitimately a no-op, or the user may have reverted something by hand — and
 * a check that silently corrected run-state would be substituting its own
 * guess for the record of what was reported.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { changedFilesAgainstTree, headCommit } from '../git/ops.js';
import type { RunState } from '../runstate/types.js';
import type { Workflow, WorkflowNode } from '../workflow/load.js';

/** A node whose claim the repository does not support. */
export interface ReconcileFinding {
  nodeId: string;
  /** What was looked for, phrased so a person can go and check it themselves. */
  detail: string;
}

export interface ReconcileReport {
  runId: string;
  at: string;
  /**
   * Set when the run could not be checked at all. Distinct from an empty
   * `findings` list, which means it *was* checked and everything agreed — the
   * difference between "nothing is wrong" and "nothing could be examined".
   */
  unreconcilable?: string;
  findings: ReconcileFinding[];
  /** Nodes that were checked and agreed with the tree. */
  supported: string[];
  /** Nodes deliberately not checked, and why — see {@link exemption}. */
  exempt: { nodeId: string; reason: string }[];
}

/**
 * Where a report lives: its own directory, not the run document and not
 * alongside it either.
 *
 * The requirement is that reconciliation leaves run-state byte-identical, and
 * the viewer still has to be able to show findings — a separate file satisfies
 * both. It gets its own directory rather than sitting next to the run because
 * everything that lists runs globs `*.json` under `runs/`, so a report parked
 * there is picked up as a run with no nodes: `flow-code watch` attaches to it,
 * `status` reports on it, and the real run disappears from view. Found by
 * running the command twice in a row.
 */
export function reportPath(repoRoot: string, runId: string): string {
  return join(repoRoot, '.flow-code', 'reconcile', `${runId}.json`);
}

export function readReport(repoRoot: string, runId: string): ReconcileReport | undefined {
  try {
    return JSON.parse(readFileSync(reportPath(repoRoot, runId), 'utf8')) as ReconcileReport;
  } catch {
    return undefined;
  }
}

/**
 * Why a completed node is not worth checking against the main tree.
 *
 * The open design question this settles is "which node types are expected to
 * modify the repository". Answered from the capability set rather than from a
 * list of type names, so a new node type is classified correctly the day it is
 * added instead of the day someone remembers to update a table here:
 *
 * - No `edit` and no `git-write` means the type cannot change the repository
 *   even in principle. Reviewing, validating, discussing, and running tests all
 *   land here — flagging them for leaving the tree alone would be flagging them
 *   for doing their job.
 * - Worktree-Agent is the one exemption by name rather than by capability. It
 *   holds `edit`, but its work lands on a branch in its own checkout and only
 *   reaches this tree if the run converges it, so the main tree is simply the
 *   wrong place to look.
 */
function exemption(node: WorkflowNode): string | undefined {
  if (node.type.id === 'worktree-agent') {
    return 'works in its own checkout; its changes reach this tree only on convergence';
  }
  const caps = node.type.capabilities;
  if (!caps.includes('edit') && !caps.includes('git-write')) {
    return `${node.type.displayName} does not modify the repository`;
  }
  return undefined;
}

/** A claim a node's own output makes, which the tree can be asked about. */
interface Claim {
  detail: string;
  supported: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Repo-relative, so a claimed path compares against what `git diff` reports. */
function repoRelative(repoRoot: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(repoRoot, path);
  return relative(resolve(repoRoot), abs).split('\\').join('/');
}

/**
 * What a node's recorded output asserts about the repository.
 *
 * Reading the output rather than only asking "did anything change" is what
 * makes a finding actionable: "`implement` says it changed src/a.ts, and
 * src/a.ts is identical to the baseline" is something a person can check in one
 * command, where "the tree looks unchanged" is not.
 */
function claimsOf(
  node: WorkflowNode,
  output: unknown,
  ctx: { repoRoot: string; changed: Set<string>; head: string; baselineCommit: string },
): Claim[] {
  const record = asRecord(output);
  const claims: Claim[] = [];
  if (!record) return claims;

  const changedFiles = record['changedFiles'];
  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    const missing = changedFiles
      .filter((f): f is string => typeof f === 'string')
      .filter((f) => !ctx.changed.has(repoRelative(ctx.repoRoot, f)));
    claims.push({
      supported: missing.length === 0,
      detail:
        missing.length === 0
          ? 'the files it reported changing differ from the baseline'
          : `reported changing ${missing.map((f) => `\`${f}\``).join(', ')}, but ${
              missing.length === 1 ? 'it is' : 'they are'
            } unchanged from the run's baseline`,
    });
  }

  const specPath = record['specPath'];
  if (typeof specPath === 'string' && specPath !== '') {
    const abs = isAbsolute(specPath) ? specPath : join(ctx.repoRoot, specPath);
    claims.push({
      supported: existsSync(abs),
      detail: existsSync(abs)
        ? `wrote \`${specPath}\``
        : `reported writing \`${specPath}\`, which does not exist`,
    });
  }

  if (record['committed'] === true) {
    const moved = ctx.head !== ctx.baselineCommit;
    claims.push({
      supported: moved,
      detail: moved
        ? 'HEAD has moved since the run started'
        : "reported committing, but HEAD is still the run's baseline commit",
    });
  }

  return claims;
}

/**
 * Compare a run's claims against the repository.
 *
 * Read-only with respect to run-state: nothing here opens the run document for
 * writing, and the report it produces is written elsewhere entirely.
 */
export async function reconcileRun(
  repoRoot: string,
  state: RunState,
  workflow: Workflow,
): Promise<ReconcileReport> {
  const base: ReconcileReport = {
    runId: state.runId,
    at: new Date().toISOString(),
    findings: [],
    supported: [],
    exempt: [],
  };

  if (!state.baseline) {
    // Reported as unreconcilable rather than as "nothing wrong". A run with no
    // reference point cannot disagree with the tree, and letting that read as
    // agreement would turn the absence of a check into a clean bill of health.
    return {
      ...base,
      unreconcilable:
        'this run recorded no baseline, so there is nothing to compare the repository against',
    };
  }

  let changed: Set<string>;
  let head: string;
  try {
    changed = new Set(await changedFilesAgainstTree(repoRoot, state.baseline.tree));
    head = await headCommit(repoRoot);
  } catch (err) {
    return {
      ...base,
      unreconcilable: `the repository could not be compared against the run's baseline: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const ctx = { repoRoot, changed, head, baselineCommit: state.baseline.commit };
  const report: ReconcileReport = { ...base };

  for (const node of workflow.nodes) {
    if (state.nodes[node.id]?.status !== 'done') continue;

    const exempt = exemption(node);
    if (exempt !== undefined) {
      report.exempt.push({ nodeId: node.id, reason: exempt });
      continue;
    }

    const claims = claimsOf(node, state.nodes[node.id]?.output, ctx);
    if (claims.length > 0) {
      const unsupported = claims.filter((c) => !c.supported);
      if (unsupported.length === 0) report.supported.push(node.id);
      else for (const claim of unsupported) report.findings.push({ nodeId: node.id, detail: claim.detail });
      continue;
    }

    // No checkable claim in the output, so fall back to the coarse question:
    // a node that can change the repository, reported complete, over a tree
    // that has not moved at all since the run began.
    if (changed.size === 0) {
      report.findings.push({
        nodeId: node.id,
        detail: `reported complete, but nothing in the repository has changed since the run started`,
      });
    } else {
      report.supported.push(node.id);
    }
  }

  return report;
}

/** Write a report beside the run document — never into it. */
export function writeReport(repoRoot: string, report: ReconcileReport): void {
  const path = reportPath(repoRoot, report.runId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2));
  renameSync(tmp, path);
}

/** Discard a stale report, so an old verdict cannot outlive what it judged. */
export function clearReport(repoRoot: string, runId: string): void {
  try {
    unlinkSync(reportPath(repoRoot, runId));
  } catch {
    // Never written, or already gone.
  }
}

/** The report as a person reads it. */
export function formatReport(report: ReconcileReport): string {
  if (report.unreconcilable !== undefined) {
    return `run ${report.runId.slice(0, 8)} cannot be reconciled — ${report.unreconcilable}`;
  }
  const lines = [`run ${report.runId.slice(0, 8)} — checked against the repository`];
  if (report.findings.length === 0) {
    lines.push(
      report.supported.length === 0
        ? '  nothing to check: no completed node claims anything the tree can confirm'
        : `  ${report.supported.length} node(s) agree with the tree`,
    );
  } else {
    lines.push(`  ${report.findings.length} claim(s) the repository does not support:`);
    for (const finding of report.findings) lines.push(`    ${finding.nodeId}: ${finding.detail}`);
  }
  for (const { nodeId, reason } of report.exempt) lines.push(`  skipped ${nodeId} — ${reason}`);
  return lines.join('\n');
}
