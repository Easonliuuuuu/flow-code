export const PROVIDERS = [
    { id: 'claude', label: 'Claude (Anthropic)' },
    { id: 'nvidia', label: 'NVIDIA NIM', apiKeyEnvVar: 'NVIDIA_API_KEY' },
    { id: 'openai', label: 'OpenAI', apiKeyEnvVar: 'OPENAI_API_KEY' },
    { id: 'openrouter', label: 'OpenRouter', apiKeyEnvVar: 'OPENROUTER_API_KEY' },
];
export function providerInfo(id) {
    const info = PROVIDERS.find((p) => p.id === id);
    if (!info)
        throw new Error(`unknown provider "${id}"`);
    return info;
}
export function isProviderId(value) {
    return PROVIDERS.some((p) => p.id === value);
}
//# sourceMappingURL=providers.js.map