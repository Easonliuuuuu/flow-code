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

/**
 * Config fields simple enough to edit as free text, per node type. An
 * explicit table rather than something derived from each type's zod schema:
 * the point is to expose the two or three fields a user actually retypes
 * mid-run, not every field a schema happens to accept.
 */
const EDITABLE_CONFIG: Record<string, Array<{ key: string; label: string }>> = {
  discuss: [{ key: 'topic', label: 'topic' }],
  spec: [{ key: 'title', label: 'title' }],
  implement: [{ key: 'instructions', label: 'instructions' }],
  validate: [{ key: 'instructions', label: 'instructions' }],
  review: [{ key: 'instructions', label: 'instructions' }],
  'git-ops': [{ key: 'commitMessage', label: 'commit message' }],
  'approval-gate': [{ key: 'title', label: 'title' }],
};

/** The fields the editor offers for one node, in the order it shows them. */
export function editableFields(node: WorkflowNode): EditorField[] {
  const config = (node.config ?? {}) as Record<string, unknown>;
  const fields: EditorField[] = [
    {
      key: 'budget.tokens',
      label: 'token budget',
      kind: 'number',
      value: node.budget?.tokens !== undefined ? String(node.budget.tokens) : '',
      placeholder: 'unset — falls back to settings.budget.tokensPerNode',
    },
  ];
  for (const { key, label } of EDITABLE_CONFIG[node.type.id] ?? []) {
    fields.push({
      key,
      label,
      kind: 'string',
      value: typeof config[key] === 'string' ? (config[key] as string) : '',
      placeholder: 'unset',
    });
  }
  return fields;
}

export type ParsedFieldValue =
  | { ok: true; kind: 'number'; value: number | null }
  | { ok: true; kind: 'string'; value: string | null }
  | { ok: false; error: string };

/**
 * Validate what was typed into `field`. An empty input clears the field —
 * that is the only way to get back to "inherit the run-wide budget" once a
 * node has its own, so it has to be spelled out rather than rejected as
 * empty input.
 */
export function parseFieldValue(field: EditorField, input: string): ParsedFieldValue {
  const text = input.trim();
  if (text.length === 0) {
    return field.kind === 'number'
      ? { ok: true, kind: 'number', value: null }
      : { ok: true, kind: 'string', value: null };
  }
  if (field.kind === 'number') {
    // Thousands separators are how people write token counts; the schema
    // wants an integer.
    const n = Number(text.replace(/[_,]/g, ''));
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: `${field.label} must be a whole number of at least 1` };
    }
    return { ok: true, kind: 'number', value: n };
  }
  return { ok: true, kind: 'string', value: text };
}
