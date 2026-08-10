import type { CompatToolDef } from '../harness/compatTools.js';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Token usage for one response, in the shape the run-state store accumulates.
 *
 * No `cacheWrite`: the OpenAI-compatible usage block reports cached prompt
 * tokens as one number, and on these endpoints caching is automatic and
 * unbilled as a separate write — so everything it reports is a read.
 */
export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Not every OpenAI-compatible endpoint reports usage, and some omit the
 * cached-token breakdown — a missing field reads as zero rather than
 * suppressing the whole report.
 */
function usageOf(data: ChatCompletionResponse): ChatUsage | undefined {
  if (!data.usage) return undefined;
  const cacheRead = data.usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    // `prompt_tokens` is inclusive of cached tokens; split them so the two
    // never double-count in a total.
    input: Math.max(0, (data.usage.prompt_tokens ?? 0) - cacheRead),
    output: data.usage.completion_tokens ?? 0,
    cacheRead,
  };
}

/** Thrown on a non-2xx response or a malformed body; carries enough detail to log usefully. */
export class OpenAiCompatApiError extends Error {}

/**
 * Statuses worth retrying: rate limiting and transient server errors. 4xx
 * client errors (401, 400, …) are never retried — retrying them just wastes
 * time and quota.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Retries after the initial attempt for a retryable status. */
const MAX_RETRIES = 3;

/**
 * Per-attempt request timeout. Observed against a hosted inference endpoint
 * under load: a connection is accepted and then simply never answered — no error,
 * no 429/503, nothing — so a plain `fetch` with no client-side timeout can
 * hang for the lifetime of the run instead of hitting the retry path.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/** Combines the caller's cancellation signal (if any) with a fresh per-attempt timeout. */
function attemptSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Backoff before the next retry: a server-provided `Retry-After` (capped so a
 * long window can't stall the run), else exponential backoff with jitter.
 */
function retryDelayMs(attempt: number, retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return Math.min(Math.max(0, retryAfterSeconds) * 1000, 10_000);
  }
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base + Math.floor(Math.random() * 500);
}

/**
 * One chat-completions call against any OpenAI-compatible endpoint (OpenAI,
 * OpenRouter, …) — the request/response shape is standard
 * across all of them, only the base URL, key, and model differ.
 *
 * `apiKeys` supports rotation: when every retry on the current key is still
 * met with a retryable status, the call moves on to the next key (fresh
 * quota, no backoff needed for the switch itself) instead of giving up.
 * Most providers only ever have one key configured, so this is a no-op loop
 * of length one for them.
 */
export async function callOpenAiCompatChat(opts: {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools: CompatToolDef[];
  apiKeys: string[];
  signal?: AbortSignal;
  /** Called once per successful response, so token counts climb live mid-turn. */
  onUsage?: (usage: ChatUsage) => void;
}): Promise<ChatMessage> {
  const payload = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    // Some providers 400 on a response requesting more than one tool call
    // at once; the loop only ever needs one per turn anyway.
    ...(opts.tools.length > 0 ? { tools: opts.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
  });
  const request = (apiKey: string): Promise<Response> =>
    fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      signal: attemptSignal(opts.signal),
    });

  let lastDetail = '';

  for (let keyIndex = 0; keyIndex < opts.apiKeys.length; keyIndex++) {
    const apiKey = opts.apiKeys[keyIndex]!;
    const hasNextKey = keyIndex < opts.apiKeys.length - 1;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await request(apiKey);
      } catch (err) {
        // The caller's own cancellation (not our per-attempt timeout) should
        // propagate immediately rather than being retried or rotated past.
        if (opts.signal?.aborted) throw new OpenAiCompatApiError(`${opts.baseUrl} request aborted`);
        lastDetail = `request failed: ${err instanceof Error ? err.message : String(err)}`;
        if (attempt >= MAX_RETRIES) {
          if (hasNextKey) {
            console.warn(
              `flow-code: ${opts.baseUrl} still failing (${lastDetail}) after ${MAX_RETRIES} retries; rotating to the next API key…`,
            );
            break;
          }
          throw new OpenAiCompatApiError(`${opts.baseUrl} request failed: ${lastDetail}`);
        }
        const delay = retryDelayMs(attempt, undefined);
        console.warn(`flow-code: ${opts.baseUrl} request failed (${lastDetail}); retrying in ${Math.round(delay)}ms…`);
        await sleep(delay, opts.signal);
        continue;
      }

      if (res.ok) {
        const data = (await res.json()) as ChatCompletionResponse;
        const message = data.choices?.[0]?.message;
        if (!message) throw new OpenAiCompatApiError(`${opts.baseUrl} response contained no choices[0].message`);
        const usage = usageOf(data);
        if (usage) opts.onUsage?.(usage);
        return message;
      }

      const body = await res.text().catch(() => '');
      lastDetail = `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`;

      if (!RETRYABLE_STATUS.has(res.status) || opts.signal?.aborted) {
        throw new OpenAiCompatApiError(`${opts.baseUrl} request failed: ${lastDetail}`);
      }

      if (attempt >= MAX_RETRIES) {
        if (hasNextKey) {
          console.warn(
            `flow-code: ${opts.baseUrl} still ${res.status} ${res.statusText} after ${MAX_RETRIES} retries; rotating to the next API key…`,
          );
          break;
        }
        throw new OpenAiCompatApiError(`${opts.baseUrl} request failed: ${lastDetail}`);
      }

      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = retryDelayMs(attempt, Number.isNaN(retryAfter) ? undefined : retryAfter);
      console.warn(
        `flow-code: ${opts.baseUrl} returned ${res.status} ${res.statusText}; retrying in ${Math.round(delay)}ms…`,
      );
      await sleep(delay, opts.signal);
    }
  }

  throw new OpenAiCompatApiError(`${opts.baseUrl} request failed: ${lastDetail}`);
}
