import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirty, worktreeSupported } from '../git/ops.js';
import type { Workflow } from '../workflow/load.js';
import { discussProviderInfo, type DiscussProviderId } from './providers.js';

export type PreflightFailureKind =
  | 'credentials'
  | 'nvidia-credentials'
  | 'worktree-support'
  | 'dirty-tree';

export class PreflightError extends Error {
  constructor(
    readonly kind: PreflightFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

export function defaultCredentialsResolver(): boolean {
  if (process.env['ANTHROPIC_API_KEY']) return true;
  if (process.env['CLAUDE_CODE_OAUTH_TOKEN']) return true;
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}

export function defaultNvidiaCredentialsResolver(): boolean {
  return Boolean(process.env['NVIDIA_API_KEY']);
}

/** Checks the env var for whichever provider Discuss is configured to use. */
export function defaultDiscussCredentialsResolver(provider: DiscussProviderId): boolean {
  if (provider === 'claude') return defaultCredentialsResolver();
  const envVar = discussProviderInfo(provider).apiKeyEnvVar!;
  return Boolean(process.env[envVar]);
}

/** Every agent-driven node type other than Discuss routes to the NVIDIA-backed runner. */
export function workflowNeedsNvidia(workflow: Workflow): boolean {
  return workflow.nodes.some((n) => n.type.agentDriven && n.type.id !== 'discuss');
}

export interface PreflightOptions {
  allowDirty: boolean;
  /** Which provider Discuss is configured to use; defaults to 'claude' (back-compat). */
  discussProvider?: DiscussProviderId;
  /** Injectable for tests. */
  credentialsResolver?: (provider: DiscussProviderId) => boolean;
  /** Injectable for tests. */
  nvidiaCredentialsResolver?: () => boolean;
}

/**
 * All checks run before any node starts and before anything is created or
 * modified, so failure is a clear message at second zero — never a crash
 * three nodes in with a worktree already on disk.
 */
export async function preflight(
  workflow: Workflow,
  repoRoot: string,
  opts: PreflightOptions,
): Promise<void> {
  const hasDiscussNode = workflow.nodes.some((n) => n.type.id === 'discuss');
  if (hasDiscussNode) {
    const discussProvider = opts.discussProvider ?? 'claude';
    const hasCredentials = (opts.credentialsResolver ?? defaultDiscussCredentialsResolver)(discussProvider);
    if (!hasCredentials) {
      throw new PreflightError(
        'credentials',
        discussProvider === 'claude'
          ? 'No Claude Agent SDK credentials found. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN), or log in with the claude CLI.'
          : `No ${discussProviderInfo(discussProvider).label} API key found. Set the ${discussProviderInfo(discussProvider).apiKeyEnvVar} environment variable, or re-run to be prompted for one.`,
      );
    }
  }

  if (workflowNeedsNvidia(workflow)) {
    const hasNvidiaCredentials = (opts.nvidiaCredentialsResolver ?? defaultNvidiaCredentialsResolver)();
    if (!hasNvidiaCredentials) {
      throw new PreflightError(
        'nvidia-credentials',
        'No NVIDIA API key found. This workflow has an agent-driven node other than Discuss, which routes to the NVIDIA-backed runner — set the NVIDIA_API_KEY environment variable.',
      );
    }
  }

  const needsWorktrees = workflow.nodes.some((n) => n.type.id === 'worktree-agent');
  if (needsWorktrees && !(await worktreeSupported(repoRoot))) {
    throw new PreflightError(
      'worktree-support',
      'This workflow contains a Worktree-Agent node, but `git worktree` is not available in this repository/environment.',
    );
  }

  if (!opts.allowDirty && (await isDirty(repoRoot))) {
    throw new PreflightError(
      'dirty-tree',
      'The working tree has uncommitted changes. flow-code refuses to start because pre-existing changes would be indistinguishable from agent changes in approval diffs. Commit or stash them, or pass --allow-dirty to snapshot the current tree as the run baseline.',
    );
  }
}
