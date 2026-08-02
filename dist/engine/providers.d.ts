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
export declare const PROVIDERS: ProviderInfo[];
export declare function providerInfo(id: ProviderId): ProviderInfo;
export declare function isProviderId(value: string): value is ProviderId;
