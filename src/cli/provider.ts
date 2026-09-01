import { loadCredentials } from '../engine/credentials.js';
import { defaultCodexCredentialsResolver, defaultCredentialsResolver } from '../engine/preflight.js';
import { PROVIDERS, providerInfo, type ProviderId } from '../engine/providers.js';
import type { SessionRunner } from '../engine/types.js';
import {
  CodexSessionRunner,
  OpenAiSessionRunner,
  OpenRouterSessionRunner,
  OrcaRouterSessionRunner,
  SdkSessionRunner,
} from '../executors/index.js';
import { nodeWantsAgentStep } from '../registry/index.js';
import type { Workflow } from '../workflow/load.js';
import { fail } from './context.js';

/**
 * Determines which provider backs every agent-driven node in this run, and
 * makes sure its API key ends up in the environment. Order of preference: a
 * previously saved per-repo choice (from `flow-code init`), then an
 * already-set env var for any provider, then the Claude Agent SDK's own
 * credential resolution. Never prompts — `flow-code init` is where that
 * happens now; a workflow with a node that wants an agent session and
 * nothing configured fails fast with a pointer to it. A workflow with no
 * node that wants one at all returns undefined, since no provider is ever
 * actually needed. "Wants one" includes a Test/Approval-Gate node with
 * `agent: true` and skills/instructions configured, not just the
 * always-agent-driven types.
 */
export async function resolveProvider(
  repoRoot: string,
  workflow: Workflow,
): Promise<{ provider: ProviderId; model?: string } | undefined> {
  const saved = loadCredentials(repoRoot);
  if (saved) {
    const envVar = providerInfo(saved.provider).apiKeyEnvVar;
    if (envVar && saved.apiKey && !process.env[envVar]) {
      process.env[envVar] = saved.apiKey;
    }
    if (envVar && saved.apiKey2 && !process.env[`${envVar}_2`]) {
      process.env[`${envVar}_2`] = saved.apiKey2;
    }
    return { provider: saved.provider, model: saved.model };
  }

  for (const info of PROVIDERS) {
    if (info.apiKeyEnvVar && process.env[info.apiKeyEnvVar]) return { provider: info.id };
  }
  if (defaultCredentialsResolver()) return { provider: 'claude' };
  if (defaultCodexCredentialsResolver()) return { provider: 'codex' };

  if (workflow.nodes.some(nodeWantsAgentStep)) {
    fail(
      'no provider configured — run `flow-code init` to choose one, or set ' +
        'ANTHROPIC_API_KEY / CODEX_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / ORCAROUTER_API_KEY.',
    );
  }
  return undefined;
}

export function buildRunner(provider: ProviderId): SessionRunner {
  switch (provider) {
    case 'claude':
      return new SdkSessionRunner();
    case 'codex':
      return new CodexSessionRunner();
    case 'openai':
      return new OpenAiSessionRunner();
    case 'openrouter':
      return new OpenRouterSessionRunner();
    case 'orcarouter':
      return new OrcaRouterSessionRunner();
  }
}
