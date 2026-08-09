import { OPENAI_BASE_URL } from '../executors/openaiRunner.js';
import { OPENROUTER_BASE_URL } from '../executors/openrouterRunner.js';
import type { ProviderId } from '../engine/providers.js';

/** No live model catalog for Claude at picker time — see CLAUDE_MODELS below. */
const CLAUDE_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'];

/**
 * Same story as Claude: Codex runs through a CLI subprocess, not a queryable
 * /v1/models endpoint. Model naming in this family moves fast — this list is
 * a rough starting point, not authoritative; the picker's free-text entry is
 * the real escape hatch, and omitting `model` in ThreadOptions lets the CLI
 * pick its own current default anyway.
 */
const CODEX_MODELS = ['gpt-5.1-codex', 'gpt-5.1-codex-mini'];

const MODEL_LIST_TIMEOUT_MS = 10_000;

/** OpenAI's /v1/models lists every model family, not just chat — trim the obvious non-chat ones. */
const NON_CHAT_ID_PATTERN =
  /whisper|^tts-|dall-e|embedding|moderation|^babbage|^davinci|^text-|realtime|audio/i;

export interface ModelListResult {
  models: string[];
  error?: string;
}

function baseUrlFor(provider: ProviderId): string {
  switch (provider) {
    case 'openai':
      return OPENAI_BASE_URL;
    case 'openrouter':
      return OPENROUTER_BASE_URL;
    case 'claude':
      throw new Error('claude has no /v1/models endpoint here — use the static list instead');
    case 'codex':
      throw new Error('codex has no /v1/models endpoint here — use the static list instead');
  }
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
export async function fetchModelIds(provider: ProviderId, apiKey: string | undefined): Promise<ModelListResult> {
  if (provider === 'claude') return { models: CLAUDE_MODELS };
  if (provider === 'codex') return { models: CODEX_MODELS };

  try {
    const res = await fetch(`${baseUrlFor(provider)}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { models: [], error: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}` };
    }
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    let ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (provider === 'openai') ids = ids.filter((id) => !NON_CHAT_ID_PATTERN.test(id));
    return { models: [...ids].sort() };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
