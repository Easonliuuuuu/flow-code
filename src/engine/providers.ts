/** Providers flow-code can run every agent-driven node against. */
export type ProviderId = 'claude' | 'nvidia' | 'openai' | 'openrouter';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /**
   * Env var checked for credentials. Claude has none here — it falls back to
   * the Claude Agent SDK's own credential resolution (ANTHROPIC_API_KEY,
   * CLAUDE_CODE_OAUTH_TOKEN, or a `claude` CLI login), see preflight.ts.
   */
  apiKeyEnvVar?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'nvidia', label: 'NVIDIA NIM', apiKeyEnvVar: 'NVIDIA_API_KEY' },
  { id: 'openai', label: 'OpenAI', apiKeyEnvVar: 'OPENAI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', apiKeyEnvVar: 'OPENROUTER_API_KEY' },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const info = PROVIDERS.find((p) => p.id === id);
  if (!info) throw new Error(`unknown provider "${id}"`);
  return info;
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}
