import type { NvidiaToolDef } from '../harness/nvidiaTools.js';

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
 * One chat-completions call against any OpenAI-compatible endpoint (NVIDIA
 * NIM, OpenAI, OpenRouter, …) — the request/response shape is standard
 * across all of them, only the base URL, key, and model differ.
 */
export async function callOpenAiCompatChat(opts: {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools: NvidiaToolDef[];
  apiKey: string;
  signal?: AbortSignal;
}): Promise<ChatMessage> {
  const payload = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    // Some providers 400 on a response requesting more than one tool call
    // at once; the loop only ever needs one per turn anyway.
    ...(opts.tools.length > 0 ? { tools: opts.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
  });
  const request = (): Promise<Response> =>
    fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: payload,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

  const res = await request();

  if (res.ok) {
    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) throw new OpenAiCompatApiError(`${opts.baseUrl} response contained no choices[0].message`);
    return message;
  }

  const body = await res.text().catch(() => '');
  const detail = `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`;

  let current = res;
  if (RETRYABLE_STATUS.has(current.status) && !opts.signal?.aborted) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const retryAfter = Number(current.headers.get('retry-after'));
      const delay = retryDelayMs(attempt, Number.isNaN(retryAfter) ? undefined : retryAfter);
      console.warn(
        `flow-code: ${opts.baseUrl} returned ${current.status} ${current.statusText}; retrying in ${Math.round(delay)}ms…`,
      );
      await sleep(delay, opts.signal);
      current = await request();
      if (current.ok) {
        const data = (await current.json()) as ChatCompletionResponse;
        const message = data.choices?.[0]?.message;
        if (!message) {
          throw new OpenAiCompatApiError(`${opts.baseUrl} response contained no choices[0].message`);
        }
        return message;
      }
      const retryBody = await current.text().catch(() => '');
      if (!RETRYABLE_STATUS.has(current.status) || opts.signal?.aborted) {
        throw new OpenAiCompatApiError(
          `${opts.baseUrl} request failed: ${current.status} ${current.statusText}${retryBody ? ` — ${retryBody.slice(0, 500)}` : ''}`,
        );
      }
    }
  }

  throw new OpenAiCompatApiError(`${opts.baseUrl} request failed: ${detail}`);
}
