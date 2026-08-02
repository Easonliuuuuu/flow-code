import { executeGitOps, executeImplement, executeReview, executeValidate } from './agents.js';
import { executeDiscuss } from './discuss.js';
import { executeApprovalGate } from './gate.js';
import { executeTest } from './test.js';
import { executeWorktreeAgent } from './worktree.js';
export const builtinExecutors = {
    discuss: executeDiscuss,
    implement: executeImplement,
    test: executeTest,
    validate: executeValidate,
    review: executeReview,
    'git-ops': executeGitOps,
    'worktree-agent': executeWorktreeAgent,
    'approval-gate': executeApprovalGate,
};
export { SdkSessionRunner } from './sdkRunner.js';
export { NvidiaSessionRunner } from './nvidiaRunner.js';
export { OpenAiSessionRunner } from './openaiRunner.js';
export { OpenRouterSessionRunner } from './openrouterRunner.js';
export { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';
//# sourceMappingURL=index.js.map