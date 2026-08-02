import type { NodeExecutor } from '../engine/types.js';
/**
 * Deterministic command runner: no agent session, no API cost. Commands run
 * in order in the node's working directory; the first failure stops the node.
 */
export declare const executeTest: NodeExecutor;
