import { z } from 'zod';

/**
 * Run-wide settings. Documented defaults:
 *  - concurrency: 2 — max concurrently running agent sessions across the run
 *  - model: unset — each session falls back to the Claude Agent SDK's default
 */
export const settingsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(16).default(2),
  model: z.string().min(1).optional(),
});

export type RunSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: RunSettings = settingsSchema.parse({});

/** Edges carry no behavior: `from` and `to` only, enforced by strictObject. */
export const edgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
});

export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const nodeEntrySchema = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'node ids must be alphanumeric with - or _'),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const workflowFileSchema = z.strictObject({
  settings: settingsSchema.optional(),
  nodes: z.array(nodeEntrySchema).min(1),
  edges: z.array(edgeSchema).default([]),
});

export type WorkflowFileRaw = z.infer<typeof workflowFileSchema>;
