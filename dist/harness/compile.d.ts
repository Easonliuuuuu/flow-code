import type { Capability, CapabilitySet } from '../capabilities.js';
export declare const READ_TOOLS: readonly ["Read", "Glob", "Grep"];
export declare const EDIT_TOOLS: readonly ["Write", "Edit", "NotebookEdit"];
export declare const EXEC_TOOLS: readonly ["Bash", "BashOutput", "KillShell"];
/** No built-in node type grants network access in v1. */
export declare const NETWORK_TOOLS: readonly ["WebFetch", "WebSearch"];
/** Subagents would put tool calls outside the interception point. */
export declare const ALWAYS_DENIED_TOOLS: readonly ["WebFetch", "WebSearch", "Task", "Agent"];
/** Harmless bookkeeping the SDK may use regardless of capabilities. */
export declare const ALWAYS_ALLOWED_TOOLS: readonly ["TodoWrite"];
export interface CompiledToolPolicy {
    disallowedTools: string[];
    /** Layer 1: states the boundary in the system prompt. Guarantees nothing. */
    boundaryPrompt: string;
    /** Env for the child process; includes the pushurl block when applicable. */
    env: Record<string, string>;
}
/**
 * Layer 2: compile a capability set into the SDK's coarse tool deny list.
 * Layer 3 (the per-call interception check) lives in intercept.ts.
 */
export declare function compileToolPolicy(caps: CapabilitySet, workingDir: string): CompiledToolPolicy;
export declare function capabilityList(caps: CapabilitySet): Capability[];
