import type { ProviderId } from '../engine/providers.js';
export interface ModelListResult {
    models: string[];
    error?: string;
}
/**
 * Fetches the list of model ids available for a provider, for the init
 * wizard's picker. Claude has no reliable key at picker time (it may rely on
 * OAuth/CLI login rather than a bare API key), so it returns a short curated
 * static list instead of hitting a network endpoint. Every other provider is
 * a single unauthenticated-cost GET against its OpenAI-compatible /v1/models
 * endpoint — no retries; a failure here just means the wizard falls back to
 * free-text model entry, not a run-blocking error.
 */
export declare function fetchModelIds(provider: ProviderId, apiKey: string | undefined): Promise<ModelListResult>;
