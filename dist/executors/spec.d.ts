import type { NodeExecutor } from '../engine/types.js';
/** Where a run's spec lives, relative to the repository root. */
export declare function specRelativePath(runId: string): string;
/**
 * Turns intent into the run's contract: a spec file on disk, plus acceptance
 * criteria that flow downstream as context and that the Validate node checks
 * one by one.
 *
 * The file is written here, by flow-code, rather than by an agent with edit
 * capability — and the harness refuses every node write into `.flow-code`. A
 * spec a node could rewrite would be a spec that gets rewritten to whatever
 * the run managed to achieve.
 */
export declare const executeSpec: NodeExecutor;
