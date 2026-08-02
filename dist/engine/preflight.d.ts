import type { Workflow } from '../workflow/load.js';
import { type ProviderId } from './providers.js';
export type PreflightFailureKind = 'credentials' | 'worktree-support' | 'dirty-tree';
export declare class PreflightError extends Error {
    readonly kind: PreflightFailureKind;
    constructor(kind: PreflightFailureKind, message: string);
}
export declare function defaultCredentialsResolver(): boolean;
/** Checks the env var for whichever provider is configured to back the project. */
export declare function defaultProviderCredentialsResolver(provider: ProviderId): boolean;
export interface PreflightOptions {
    allowDirty: boolean;
    /** Which provider backs every agent-driven node in the project; defaults to 'claude' (back-compat). */
    provider?: ProviderId;
    /** Injectable for tests. */
    credentialsResolver?: (provider: ProviderId) => boolean;
}
/**
 * All checks run before any node starts and before anything is created or
 * modified, so failure is a clear message at second zero — never a crash
 * three nodes in with a worktree already on disk.
 */
export declare function preflight(workflow: Workflow, repoRoot: string, opts: PreflightOptions): Promise<void>;
