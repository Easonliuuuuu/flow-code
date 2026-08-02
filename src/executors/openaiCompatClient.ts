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
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      // Some providers 400 on a response requesting more than one tool call
      // at once; the loop only ever needs one per turn anyway.
      ...(opts.tools.length > 0 ? { tools: opts.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new OpenAiCompatApiError(
      `${opts.baseUrl} request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`,
    );
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (!message) throw new OpenAiCompatApiError(`${opts.baseUrl} response contained no choices[0].message`);
  return message;
}
