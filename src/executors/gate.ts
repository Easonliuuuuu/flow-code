import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { capabilitySet } from '../capabilities.js';
import type { ApprovalRequest, ExecuteContext, NodeExecutor } from '../engine/types.js';
import { diffAgainstTree, git } from '../git/ops.js';
import { nodeWantsAgentStep, type ApprovalGateConfig, type GitOpsConfig, type SpecOutput, type WorktreeAgentOutput } from '../registry/index.js';
import { nodeModel, runNodeSession, truncateText, upstreamPreamble } from './helpers.js';

/**
 * Per-diff ceiling on what the gate records. Deliberately well under
 * `UPSTREAM_OUTPUT_LIMIT`: that budget is shared across every upstream output a
 * downstream node receives, so a gate that recorded a whole unbounded diff
 * would starve the review verdict that justified it. The full diff stays
 * reachable in the run's own state.
 */
const RECORDED_DIFF_LIMIT = 8 * 1024;

/** Same ceiling, same reasoning, for a document body. */
const RECORDED_DOCUMENT_LIMIT = 8 * 1024;

/**
 * A gate's non-diff subject, one per direct dependency whose result names
 * one. Read from disk rather than re-rendered from the dependency's output
 * object, so what is approved is the bytes downstream nodes will actually
 * read — and so a rejection that loops back and rewrites the file is picked
 * up on the next pass with no cache to invalidate.
 *
 * Degrades rather than throws: a document a hand-edited run state can no
 * longer find is not a reason to fail the gate, only a reason to say so
 * alongside whatever else it has.
 */
function collectDocuments(ctx: ExecuteContext): ApprovalRequest['documents'] {
  const documents: NonNullable<ApprovalRequest['documents']> = [];
  for (const depId of ctx.workflow.graph.directDependencies(ctx.node.id)) {
    const dep = ctx.workflow.nodes.find((n) => n.id === depId);
    if (dep?.type.id !== 'spec') continue;
    const output = ctx.store.node(depId).output as SpecOutput | undefined;
    if (!output?.specPath) continue;
    const absolutePath = isAbsolute(output.specPath)
      ? output.specPath
      : join(ctx.repoRoot, output.specPath);
    try {
      const body = readFileSync(absolutePath, 'utf8');
      documents.push({ label: depId, body: truncateText(body, RECORDED_DOCUMENT_LIMIT) });
    } catch {
      documents.push({
        label: depId,
        body: `_Could not read the document at \`${output.specPath}\`._`,
      });
    }
  }
  return documents.length > 0 ? documents : undefined;
}

/**
 * No agent session by default: computes the pending diff against the run
 * baseline, renders it via the approval port, and holds `waiting` until the
 * user decides. Both decisions end at `done` — a gate that got its answer
 * completed, and "the user said no" is a result rather than an execution
 * failure. What halts the branch is the recorded `decision` and the edges
 * conditioned on it: an unconditional edge out of a gate is loaded as though
 * it required approval (see `buildWorkflow`), so a rejection skips the
 * approval branch without the gate having to fail. `agent: true` adds one
 * optional, read-only-by-default critique of the diff before the human
 * decides — it never touches the decision itself.
 */
export const executeApprovalGate: NodeExecutor = async function* (ctx) {
  const config = ctx.node.config as ApprovalGateConfig;

  // Diff semantics: on the plain path, the gate's working directory vs. the
  // run baseline. Downstream of a Worktree-Agent convergence, one diff per
  // selected branch, labelled with the branch it belongs to.
  const diffs: ApprovalRequest['diffs'] = [];
  const worktreeDep = ctx.workflow.graph
    .directDependencies(ctx.node.id)
    .map((depId) => ({ depId, node: ctx.workflow.nodes.find((n) => n.id === depId)! }))
    .find(({ node }) => node.type.id === 'worktree-agent');

  const worktreeOutput = worktreeDep
    ? (ctx.store.node(worktreeDep.depId).output as WorktreeAgentOutput | undefined)
    : undefined;

  if (worktreeOutput && worktreeOutput.selected.length > 0) {
    for (const instanceId of worktreeOutput.selected) {
      const branch = worktreeOutput.branches.find((b) => b.instanceId === instanceId);
      if (!branch) continue;
      const diff = await git(['diff', ctx.baseline.tree, branch.branch], ctx.repoRoot);
      diffs.push({ label: branch.branch, diff });
    }
  } else {
    diffs.push({ diff: await diffAgainstTree(ctx.workingDir, ctx.baseline.tree) });
  }

  const documents = collectDocuments(ctx);

  const upstreamSummaries = ctx.upstream.map((u) => ({
    nodeId: u.nodeId,
    summary: truncateText(u.outputJson, 2000),
  }));

  // A user approving a diff should also know where it is going: surface the
  // push target when a push-configured Git-ops node is downstream.
  let pushTarget: ApprovalRequest['pushTarget'];
  for (const downstreamId of ctx.workflow.graph.downstreamOf(ctx.node.id)) {
    const node = ctx.workflow.nodes.find((n) => n.id === downstreamId);
    if (node?.type.id !== 'git-ops') continue;
    const gitConfig = node.config as GitOpsConfig;
    if (gitConfig.push) {
      pushTarget = {
        nodeId: node.id,
        remote: gitConfig.push.remote,
        branch: gitConfig.push.branch,
      };
      break;
    }
  }

  let agentSummary: string | undefined;
  if (nodeWantsAgentStep(ctx.node)) {
    yield { type: 'status', status: 'running', detail: 'reviewing pending changes' };
    const diffText = diffs.map((d) => (d.label ? `── ${d.label} ──\n${d.diff}` : d.diff)).join('\n\n');
    const capabilities = capabilitySet(...(config.capabilities ?? ['read']));
    const prompt =
      `${upstreamPreamble(ctx.upstream)}## Pending diff awaiting approval\n\n${truncateText(diffText, 20_000)}\n\n` +
      (config.instructions ? `${config.instructions}\n\n` : '') +
      'Give the person about to approve or reject this a short, plain-text critique: correctness risks, ' +
      'anything worth double-checking, anything that looks wrong. Respond in plain prose, not JSON.';
    const finalText = await runNodeSession(ctx, capabilities, prompt, nodeModel(ctx, undefined));
    agentSummary = truncateText(finalText.trim(), 4000);
  }

  yield { type: 'status', status: 'waiting', detail: 'awaiting approval' };
  const decision = await ctx.ports.approval.request({
    nodeId: ctx.node.id,
    title: config.title ?? `Approve changes at ${ctx.node.id}`,
    diffs,
    ...(documents !== undefined ? { documents } : {}),
    upstreamSummaries,
    ...(pushTarget !== undefined ? { pushTarget } : {}),
    ...(agentSummary !== undefined ? { agentSummary } : {}),
  });

  const decidedAt = new Date().toISOString();
  // Diffs and documents ride along on the result so the detail panel can
  // re-show the same view after the decision — the live approval panel is
  // only reachable while the gate is actually waiting. Truncated first:
  // every upstream output a downstream node receives shares one budget, and
  // an unbounded diff or document here would crowd out the review that
  // justified it. Documents are already bounded at collection time, but the
  // limit is repeated here so a future document source can't skip it.
  const recorded = diffs.map((d) => ({ ...d, diff: truncateText(d.diff, RECORDED_DIFF_LIMIT) }));
  const recordedDocuments = documents?.map((d) => ({
    ...d,
    body: truncateText(d.body, RECORDED_DOCUMENT_LIMIT),
  }));
  if (decision === 'approve') {
    yield {
      type: 'result',
      output: {
        decision: 'approved',
        decidedAt,
        diffs: recorded,
        ...(recordedDocuments !== undefined ? { documents: recordedDocuments } : {}),
      },
    };
    yield { type: 'status', status: 'done', detail: 'approved' };
  } else {
    // A rejection is a decision, not a failure. Downstream is held back by the
    // approved-condition on the gate's out-edges, not by an `error` status.
    yield {
      type: 'result',
      output: {
        decision: 'rejected',
        decidedAt,
        diffs: recorded,
        ...(recordedDocuments !== undefined ? { documents: recordedDocuments } : {}),
      },
    };
    yield { type: 'status', status: 'done', detail: 'rejected by user' };
  }
};
