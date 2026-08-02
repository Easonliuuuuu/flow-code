import type { NvidiaToolDef } from '../harness/nvidiaTools.js';
export interface ChatToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
}
/** Token usage for one response, in the shape the run-state store accumulates. */
export interface ChatUsage {
    input: number;
    output: number;
    cached: number;
}
/** Thrown on a non-2xx response or a malformed body; carries enough detail to log usefully. */
export declare class OpenAiCompatApiError extends Error {
}
/**
 * One chat-completions call against any OpenAI-compatible endpoint (NVIDIA
 * NIM, OpenAI, OpenRouter, …) — the request/response shape is standard
 * across all of them, only the base URL, key, and model differ.
 *
 * `apiKeys` supports rotation: when every retry on the current key is still
 * met with a retryable status, the call moves on to the next key (fresh
 * quota, no backoff needed for the switch itself) instead of giving up.
 * Most providers only ever have one key configured, so this is a no-op loop
 * of length one for them.
 */
export declare function callOpenAiCompatChat(opts: {
    baseUrl: string;
    model: string;
    messages: ChatMessage[];
    tools: NvidiaToolDef[];
    apiKeys: string[];
    signal?: AbortSignal;
    /** Called once per successful response, so token counts climb live mid-turn. */
    onUsage?: (usage: ChatUsage) => void;
}): Promise<ChatMessage>;
