import type { CapabilitySet } from '../capabilities.js';
import type { RunStateStore } from '../runstate/store.js';
export interface PermissionDecision {
    behavior: 'allow' | 'deny';
    message?: string;
}
export interface InterceptorOptions {
    nodeId: string;
    instanceId?: string;
    capabilities: CapabilitySet;
    workingDir: string;
    store: RunStateStore;
}
export interface Interceptor {
    /**
     * Layer 3: inspect the actual tool input before execution. Every call —
     * allowed or denied — is appended to the activity log from here, which is
     * why the log costs nothing extra and exists without any UI.
     *
     * Wired to the SDK's PreToolUse hook, which fires for every tool call
     * (auto-allowed read tools never reach the permission prompt path).
     */
    check(toolName: string, input: Record<string, unknown>, opts?: {
        blockedPath?: string;
        toolUseID?: string;
    }): PermissionDecision;
    /**
     * Backstop for the SDK permission flow (canUseTool): applies the same
     * policy but only records *denials* — the PreToolUse hook already logged
     * the attempt as allowed (e.g. a Bash call later flagged with an
     * out-of-scope blockedPath).
     */
    promptCheck(toolName: string, input: Record<string, unknown>, opts?: {
        blockedPath?: string;
        toolUseID?: string;
    }): PermissionDecision;
    /** Complete an allowed call's log entry once the tool finished. */
    complete(toolUseId: string, result: {
        durationMs?: number;
        exitStatus?: number | null;
        error?: string;
    }): void;
}
export declare function outsideWorkingDir(workingDir: string, candidate: string): boolean;
export declare function createInterceptor(opts: InterceptorOptions): Interceptor;
