import type { RunStateStore } from '../runstate/store.js';
import { type AgentSessionRequest, type InteractiveAgentSession, type SessionRunner } from '../engine/types.js';
/**
 * Drives the Claude Agent SDK directly (no interactive `claude` shell-out),
 * with the capability harness compiled into every session.
 */
export declare class SdkSessionRunner implements SessionRunner {
    run(req: AgentSessionRequest, store: RunStateStore): Promise<{
        finalText: string;
    }>;
    openInteractive(req: AgentSessionRequest, store: RunStateStore): Promise<InteractiveAgentSession>;
}
