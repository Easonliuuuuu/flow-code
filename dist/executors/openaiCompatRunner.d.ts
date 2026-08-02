import type { RunStateStore } from '../runstate/store.js';
import { type AgentSessionRequest, type InteractiveAgentSession, type SessionRunner } from '../engine/types.js';
export interface OpenAiCompatProviderConfig {
    readonly providerId: string;
    readonly label: string;
    readonly baseUrl: string;
    readonly defaultModel: string;
    /** Env vars checked in order; every one that's set is used, in order, as a rotation pool on 429/5xx. */
    readonly apiKeyEnvVars: readonly string[];
}
/**
 * SessionRunner backed by any OpenAI-compatible chat-completions API (NVIDIA
 * NIM, OpenAI, OpenRouter, …). Brings its own tool-calling loop and
 * capability enforcement (see harness/nvidiaTools.ts, harness/nvidiaIntercept.ts)
 * since these APIs have no built-in tools or permission-hook system the way
 * the Claude Agent SDK does.
 *
 * Interactive sessions (openInteractive) have no server-side session to
 * resume, unlike the Claude SDK — on `--resume` the prior Discuss transcript
 * is replayed into the message history instead.
 */
export declare class OpenAiCompatSessionRunner implements SessionRunner {
    private readonly config;
    constructor(config: OpenAiCompatProviderConfig);
    private requireApiKeys;
    run(req: AgentSessionRequest, store: RunStateStore): Promise<{
        finalText: string;
    }>;
    openInteractive(req: AgentSessionRequest, store: RunStateStore): Promise<InteractiveAgentSession>;
}
