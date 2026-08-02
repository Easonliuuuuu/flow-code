/**
 * Layer 3 for the NVIDIA-backed runner: per-call capability check, mirroring
 * intercept.ts's contract (same PermissionDecision/ActivityEntry shapes) but
 * keyed to this runner's own tool names — there is no SDK hook to wire into.
 */
import type { CapabilitySet } from '../capabilities.js';
import { type PermissionDecision } from './intercept.js';
import type { RunStateStore } from '../runstate/store.js';
export interface NvidiaInterceptorOptions {
    nodeId: string;
    instanceId?: string;
    capabilities: CapabilitySet;
    workingDir: string;
    store: RunStateStore;
}
export interface NvidiaInterceptor {
    /** Inspect a tool call before it executes; every call is logged from here. */
    check(toolName: string, input: Record<string, unknown>, toolUseId: string): PermissionDecision;
    /** Complete an allowed call's log entry once the tool finished. */
    complete(toolUseId: string, result: {
        durationMs?: number;
        exitStatus?: number | null;
        error?: string;
    }): void;
}
export declare function createNvidiaInterceptor(opts: NvidiaInterceptorOptions): NvidiaInterceptor;
