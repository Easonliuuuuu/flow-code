import type { NodeExecutor } from '../engine/types.js';
export declare class ConvergenceConflictError extends Error {
    readonly conflictingFiles: string[];
    constructor(conflictingFiles: string[]);
}
export declare const executeWorktreeAgent: NodeExecutor;
