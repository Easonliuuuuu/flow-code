import type { NodeExecutor } from '../engine/types.js';
/**
 * Interactive sub-panel flow: the node holds at `waiting` until the user
 * explicitly signals completion (the port resolves null). The engine starts
 * no other node while a Discuss node is active.
 */
export declare const executeDiscuss: NodeExecutor;
