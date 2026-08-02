import type { NodeExecutor } from '../engine/types.js';
/**
 * No agent session: computes the pending diff against the run baseline,
 * renders it via the approval port, and holds `waiting` until the user
 * decides. Reject sets the gate to `error`; the engine then marks every
 * downstream node `skipped`.
 */
export declare const executeApprovalGate: NodeExecutor;
