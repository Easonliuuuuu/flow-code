/** Providers flow-code can run every agent-driven node against. */
export type ProviderId = 'claude' | 'codex' | 'openai' | 'openrouter' | 'orcarouter';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /**
   * Env var checked for credentials. Claude and Codex have none here — both
   * fall back to their own SDK's credential resolution (a CLI login, or an
   * SDK-specific env var checked directly rather than through this field),
   * see preflight.ts.
   */
  apiKeyEnvVar?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'codex', label: 'Codex (OpenAI)' },
  { id: 'openai', label: 'OpenAI', apiKeyEnvVar: 'OPENAI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', apiKeyEnvVar: 'OPENROUTER_API_KEY' },
  { id: 'orcarouter', label: 'OrcaRouter', apiKeyEnvVar: 'ORCAROUTER_API_KEY' },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const info = PROVIDERS.find((p) => p.id === id);
  if (!info) throw new Error(`unknown provider "${id}"`);
  return info;
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}
