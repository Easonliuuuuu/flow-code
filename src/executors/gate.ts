import type { ApprovalRequest, NodeExecutor } from '../engine/types.js';
import { diffAgainstTree, git } from '../git/ops.js';
import type { ApprovalGateConfig, GitOpsConfig, WorktreeAgentOutput } from '../registry/index.js';
import { truncateText } from './helpers.js';

/**
 * No agent session: computes the pending diff against the run baseline,
 * renders it via the approval port, and holds `waiting` until the user
 * decides. Reject sets the gate to `error`; the engine then marks every
 * downstream node `skipped`.
 */
export const executeApprovalGate: NodeExecutor = async function* (ctx) {
  const config = ctx.node.config as ApprovalGateConfig;
  yield { type: 'status', status: 'waiting', detail: 'awaiting approval' };

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

  const decision = await ctx.ports.approval.request({
    nodeId: ctx.node.id,
    title: config.title ?? `Approve changes at ${ctx.node.id}`,
    diffs,
    upstreamSummaries,
    ...(pushTarget !== undefined ? { pushTarget } : {}),
  });

  const decidedAt = new Date().toISOString();
  if (decision === 'approve') {
    yield { type: 'result', output: { decision: 'approved', decidedAt } };
    yield { type: 'status', status: 'done', detail: 'approved' };
  } else {
    yield { type: 'result', output: { decision: 'rejected', decidedAt } };
    yield { type: 'status', status: 'error', detail: 'rejected by user' };
  }
};
