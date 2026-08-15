import { capabilitySet } from '../capabilities.js';
import type { ApprovalRequest, NodeExecutor } from '../engine/types.js';
import { diffAgainstTree, git } from '../git/ops.js';
import { nodeWantsAgentStep, type ApprovalGateConfig, type GitOpsConfig, type WorktreeAgentOutput } from '../registry/index.js';
import { nodeModel, runNodeSession, truncateText, upstreamPreamble } from './helpers.js';

/**
 * Per-diff ceiling on what the gate records. Deliberately well under
 * `UPSTREAM_OUTPUT_LIMIT`: that budget is shared across every upstream output a
 * downstream node receives, so a gate that recorded a whole unbounded diff
 * would starve the review verdict that justified it. The full diff stays
 * reachable in the run's own state.
 */
const RECORDED_DIFF_LIMIT = 8 * 1024;

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
    upstreamSummaries,
    ...(pushTarget !== undefined ? { pushTarget } : {}),
    ...(agentSummary !== undefined ? { agentSummary } : {}),
  });

  const decidedAt = new Date().toISOString();
  // Diffs ride along on the result so the detail panel can re-show the same
  // green/red view after the decision — the live approval panel is only
  // reachable while the gate is actually waiting. Truncated first: every
  // upstream output a downstream node receives shares one budget, and an
  // unbounded diff here would crowd out the review that justified it.
  const recorded = diffs.map((d) => ({ ...d, diff: truncateText(d.diff, RECORDED_DIFF_LIMIT) }));
  if (decision === 'approve') {
    yield { type: 'result', output: { decision: 'approved', decidedAt, diffs: recorded } };
    yield { type: 'status', status: 'done', detail: 'approved' };
  } else {
    // A rejection is a decision, not a failure. Downstream is held back by the
    // approved-condition on the gate's out-edges, not by an `error` status.
    yield { type: 'result', output: { decision: 'rejected', decidedAt, diffs: recorded } };
    yield { type: 'status', status: 'done', detail: 'rejected by user' };
  }
};
