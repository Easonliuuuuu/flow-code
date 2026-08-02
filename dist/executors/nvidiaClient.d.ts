import type { NvidiaToolDef } from '../harness/nvidiaTools.js';
import { OpenAiCompatApiError, type ChatMessage, type ChatToolCall } from './openaiCompatClient.js';
export declare const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export declare const DEFAULT_NVIDIA_MODEL = "meta/llama-3.1-70b-instruct";
export type NvidiaToolCall = ChatToolCall;
export type NvidiaMessage = ChatMessage;
/** Thrown on a non-2xx response or a malformed body; carries enough detail to log usefully. */
export declare class NvidiaApiError extends OpenAiCompatApiError {
}
export declare function nvidiaApiKey(): string | undefined;
export declare function callNvidiaChat(opts: {
    model: string;
    messages: NvidiaMessage[];
    tools: NvidiaToolDef[];
    apiKey: string;
    signal?: AbortSignal;
}): Promise<NvidiaMessage>;
