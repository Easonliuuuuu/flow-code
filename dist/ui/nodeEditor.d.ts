import type { WorkflowNode } from '../workflow/load.js';
/**
 * What the run UI lets you change on a node without leaving the canvas.
 *
 * Model and skills are deliberately absent: they already have their own
 * pickers (`m` and `s`), which offer a list of valid choices rather than a
 * text box, and a second way to set them would only be a worse one.
 *
 * Everything here is a scalar the user can reasonably type. Structured config
 * — test commands, worktree instances, push targets — stays in the workflow
 * file, where its shape is visible.
 */
export interface EditorField {
    /** Stable key; `budget.tokens` is the engine's, the rest are config keys. */
    key: string;
    label: string;
    kind: 'number' | 'string';
    /** Current value as the user would type it; empty when unset. */
    value: string;
    /** Shown under the input when the field is empty. */
    placeholder: string;
}
/** The fields the editor offers for one node, in the order it shows them. */
export declare function editableFields(node: WorkflowNode): EditorField[];
export type ParsedFieldValue = {
    ok: true;
    kind: 'number';
    value: number | null;
} | {
    ok: true;
    kind: 'string';
    value: string | null;
} | {
    ok: false;
    error: string;
};
/**
 * Validate what was typed into `field`. An empty input clears the field —
 * that is the only way to get back to "inherit the run-wide budget" once a
 * node has its own, so it has to be spelled out rather than rejected as
 * empty input.
 */
export declare function parseFieldValue(field: EditorField, input: string): ParsedFieldValue;
