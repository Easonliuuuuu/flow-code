/** Providers Discuss can run against. Claude is the default/back-compat choice. */
export type DiscussProviderId = 'claude' | 'nvidia' | 'openai' | 'openrouter';

export interface DiscussProviderInfo {
  id: DiscussProviderId;
  label: string;
  /**
   * Env var checked for credentials. Claude has none here — it falls back to
   * the Claude Agent SDK's own credential resolution (ANTHROPIC_API_KEY,
   * CLAUDE_CODE_OAUTH_TOKEN, or a `claude` CLI login), see preflight.ts.
   */
  apiKeyEnvVar?: string;
}

export const DISCUSS_PROVIDERS: DiscussProviderInfo[] = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'nvidia', label: 'NVIDIA NIM', apiKeyEnvVar: 'NVIDIA_API_KEY' },
  { id: 'openai', label: 'OpenAI', apiKeyEnvVar: 'OPENAI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', apiKeyEnvVar: 'OPENROUTER_API_KEY' },
];

export function discussProviderInfo(id: DiscussProviderId): DiscussProviderInfo {
  const info = DISCUSS_PROVIDERS.find((p) => p.id === id);
  if (!info) throw new Error(`unknown discuss provider "${id}"`);
  return info;
}

export function isDiscussProviderId(value: string): value is DiscussProviderId {
  return DISCUSS_PROVIDERS.some((p) => p.id === value);
}
