import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirty, worktreeSupported } from '../git/ops.js';
import { nodeWantsAgentStep } from '../registry/index.js';
import { skillPortabilityWarnings } from '../skills/report.js';
import type { Workflow } from '../workflow/load.js';
import { providerInfo, type ProviderId } from './providers.js';

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

/**
 * Codex SDK's own resolution order is apiKey option, then OPENAI_API_KEY,
 * then CODEX_API_KEY, then an existing `codex` CLI login — this mirrors that
 * last-resort check (CODEX_HOME defaults to ~/.codex) so preflight can fail
 * fast with a clear message instead of letting the subprocess fail later.
 */
export function defaultCodexCredentialsResolver(): boolean {
  if (process.env['OPENAI_API_KEY']) return true;
  if (process.env['CODEX_API_KEY']) return true;
  const codexHome = process.env['CODEX_HOME'] || join(homedir(), '.codex');
  return existsSync(join(codexHome, 'auth.json'));
}

/** Checks the env var for whichever provider is configured to back the project. */
export function defaultProviderCredentialsResolver(provider: ProviderId): boolean {
  if (provider === 'claude') return defaultCredentialsResolver();
  if (provider === 'codex') return defaultCodexCredentialsResolver();
  const envVar = providerInfo(provider).apiKeyEnvVar!;
  return Boolean(process.env[envVar]);
}

export interface PreflightOptions {
  allowDirty: boolean;
  /** Which provider backs every agent-driven node in the project; defaults to 'claude' (back-compat). */
  provider?: ProviderId;
  /** Injectable for tests. */
  credentialsResolver?: (provider: ProviderId) => boolean;
  /** Non-fatal findings — currently skills that will not resolve elsewhere. */
  onWarning?: (message: string) => void;
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
  // Reported before the credential check so the user sees every portability
  // problem in one pass, rather than one per failed start.
  if (opts.onWarning) {
    for (const warning of skillPortabilityWarnings(workflow)) opts.onWarning(warning);
  }

  const hasAgentNode = workflow.nodes.some(nodeWantsAgentStep);
  if (hasAgentNode) {
    const provider = opts.provider ?? 'claude';
    const hasCredentials = (opts.credentialsResolver ?? defaultProviderCredentialsResolver)(provider);
    if (!hasCredentials) {
      throw new PreflightError(
        'credentials',
        provider === 'claude'
          ? 'No Claude Agent SDK credentials found. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN), or log in with the claude CLI, then run `flow-code init`.'
          : provider === 'codex'
            ? 'No Codex credentials found. Set OPENAI_API_KEY (or CODEX_API_KEY), or log in with the codex CLI, then run `flow-code init`.'
            : `No ${providerInfo(provider).label} API key found. Run \`flow-code init\` to configure one, or set ${providerInfo(provider).apiKeyEnvVar}.`,
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
