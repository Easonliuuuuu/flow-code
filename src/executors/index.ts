import type { NodeExecutor } from '../engine/types.js';
import type { NodeTypeId } from '../registry/index.js';
import { executeGitOps, executeImplement, executeReview, executeValidate } from './agents.js';
import { executeDiscuss } from './discuss.js';
import { executePlan } from './plan.js';
import { executeSpec } from './spec.js';
import { executeApprovalGate } from './gate.js';
import { executeTest } from './test.js';
import { executeWorktreeAgent } from './worktree.js';

export const builtinExecutors: Record<NodeTypeId, NodeExecutor> = {
  discuss: executeDiscuss,
  plan: executePlan,
  spec: executeSpec,
  implement: executeImplement,
  test: executeTest,
  validate: executeValidate,
  review: executeReview,
  'git-ops': executeGitOps,
  'worktree-agent': executeWorktreeAgent,
  'approval-gate': executeApprovalGate,
};

export { SdkSessionRunner } from './sdkRunner.js';
export { CodexSessionRunner } from './codexRunner.js';
export { OpenAiSessionRunner } from './openaiRunner.js';
export { OpenRouterSessionRunner } from './openrouterRunner.js';
export { OrcaRouterSessionRunner } from './orcarouterRunner.js';
export { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';
