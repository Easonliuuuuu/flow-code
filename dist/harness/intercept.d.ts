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
/**
 * True when a path lands inside the control directory of the node's own
 * working tree — the workflow file, credentials, specs and run-state.
 *
 * Deliberately computed *relative to the working directory* rather than
 * against an absolute repo root: a Worktree-Agent instance works inside
 * `<repo>/.flow-code/worktrees/<id>`, so an absolute containment test would
 * condemn everything it does, while the relative test correctly protects that
 * instance's own `.flow-code` and leaves the rest of its checkout writable.
 */
export declare function insideControlDir(workingDir: string, candidate: string): boolean;
/**
 * Shell commands that name a control artifact. Blunter than the path check —
 * a command string can reach a file in ways no argument parser will catch
 * (`sed -i`, redirection, `tee`) — so the artifacts that anchor the run are
 * named directly and any mention of them in a command is refused. Reading
 * them is still available through the Read tool.
 *
 * `.flow-code/runs` and `.flow-code/worktrees` are deliberately absent: those
 * are working data, and a worktree's own path legitimately appears in the
 * commands run inside it.
 */
export declare const CONTROL_ARTIFACT_IN_COMMAND: RegExp;
export declare const CONTROL_DIR_DENIAL: string;
export declare function createInterceptor(opts: InterceptorOptions): Interceptor;
