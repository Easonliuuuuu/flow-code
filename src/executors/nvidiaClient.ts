import type { NvidiaToolDef } from '../harness/nvidiaTools.js';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_MODEL = 'meta/llama-3.1-70b-instruct';

export interface NvidiaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface NvidiaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: NvidiaToolCall[];
  tool_call_id?: string;
}

interface NvidiaChatResponse {
  choices: Array<{ message: NvidiaMessage; finish_reason: string }>;
}

export function nvidiaApiKey(): string | undefined {
  return process.env['NVIDIA_API_KEY'];
}

/** Thrown on a non-2xx response or a malformed body; carries enough detail to log usefully. */
export class NvidiaApiError extends Error {}

export async function callNvidiaChat(opts: {
  model: string;
  messages: NvidiaMessage[];
  tools: NvidiaToolDef[];
  apiKey: string;
  signal?: AbortSignal;
}): Promise<NvidiaMessage> {
  const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      // Some NIM-hosted models 400 on a response requesting more than one
      // tool call at once; the loop only ever needs one per turn anyway.
      ...(opts.tools.length > 0 ? { tools: opts.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new NvidiaApiError(
      `NVIDIA API request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`,
    );
  }

  const data = (await res.json()) as NvidiaChatResponse;
  const message = data.choices?.[0]?.message;
  if (!message) throw new NvidiaApiError('NVIDIA API response contained no choices[0].message');
  return message;
}
