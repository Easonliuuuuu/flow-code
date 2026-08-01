import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirty, worktreeSupported } from '../git/ops.js';
import type { Workflow } from '../workflow/load.js';

export type PreflightFailureKind = 'credentials' | 'worktree-support' | 'dirty-tree';

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

export interface PreflightOptions {
  allowDirty: boolean;
  /** Injectable for tests. */
  credentialsResolver?: () => boolean;
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
  const hasCredentials = (opts.credentialsResolver ?? defaultCredentialsResolver)();
  if (!hasCredentials) {
    throw new PreflightError(
      'credentials',
      'No Claude Agent SDK credentials found. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN), or log in with the claude CLI.',
    );
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
