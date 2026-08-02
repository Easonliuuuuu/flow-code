import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirty, worktreeSupported } from '../git/ops.js';
import { providerInfo } from './providers.js';
export class PreflightError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'PreflightError';
    }
}
export function defaultCredentialsResolver() {
    if (process.env['ANTHROPIC_API_KEY'])
        return true;
    if (process.env['CLAUDE_CODE_OAUTH_TOKEN'])
        return true;
    return existsSync(join(homedir(), '.claude', '.credentials.json'));
}
/** Checks the env var for whichever provider is configured to back the project. */
export function defaultProviderCredentialsResolver(provider) {
    if (provider === 'claude')
        return defaultCredentialsResolver();
    const envVar = providerInfo(provider).apiKeyEnvVar;
    return Boolean(process.env[envVar]);
}
/**
 * All checks run before any node starts and before anything is created or
 * modified, so failure is a clear message at second zero — never a crash
 * three nodes in with a worktree already on disk.
 */
export async function preflight(workflow, repoRoot, opts) {
    const hasAgentNode = workflow.nodes.some((n) => n.type.agentDriven);
    if (hasAgentNode) {
        const provider = opts.provider ?? 'claude';
        const hasCredentials = (opts.credentialsResolver ?? defaultProviderCredentialsResolver)(provider);
        if (!hasCredentials) {
            throw new PreflightError('credentials', provider === 'claude'
                ? 'No Claude Agent SDK credentials found. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN), or log in with the claude CLI, then run `flow-code init`.'
                : `No ${providerInfo(provider).label} API key found. Run \`flow-code init\` to configure one, or set ${providerInfo(provider).apiKeyEnvVar}.`);
        }
    }
    const needsWorktrees = workflow.nodes.some((n) => n.type.id === 'worktree-agent');
    if (needsWorktrees && !(await worktreeSupported(repoRoot))) {
        throw new PreflightError('worktree-support', 'This workflow contains a Worktree-Agent node, but `git worktree` is not available in this repository/environment.');
    }
    if (!opts.allowDirty && (await isDirty(repoRoot))) {
        throw new PreflightError('dirty-tree', 'The working tree has uncommitted changes. flow-code refuses to start because pre-existing changes would be indistinguishable from agent changes in approval diffs. Commit or stash them, or pass --allow-dirty to snapshot the current tree as the run baseline.');
    }
}
//# sourceMappingURL=preflight.js.map