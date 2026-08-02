import type { NvidiaToolDef } from '../harness/nvidiaTools.js';
import {
  callOpenAiCompatChat,
  OpenAiCompatApiError,
  type ChatMessage,
  type ChatToolCall,
} from './openaiCompatClient.js';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_MODEL = 'meta/llama-3.1-70b-instruct';

export type NvidiaToolCall = ChatToolCall;
export type NvidiaMessage = ChatMessage;

/** Thrown on a non-2xx response or a malformed body; carries enough detail to log usefully. */
export class NvidiaApiError extends OpenAiCompatApiError {}

export function nvidiaApiKey(): string | undefined {
  return process.env['NVIDIA_API_KEY'];
}

export async function callNvidiaChat(opts: {
  model: string;
  messages: NvidiaMessage[];
  tools: NvidiaToolDef[];
  apiKey: string;
  signal?: AbortSignal;
}): Promise<NvidiaMessage> {
  try {
    return await callOpenAiCompatChat({ baseUrl: NVIDIA_BASE_URL, ...opts });
  } catch (err) {
    if (err instanceof OpenAiCompatApiError) throw new NvidiaApiError(err.message);
    throw err;
  }
}
