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

/** Attempts a loop-back target may take before the run gives up on it. */
export const DEFAULT_LOOPBACK_MAX_ATTEMPTS = 3;

/**
 * `loopback: true` takes the default bound; `loopback: {maxAttempts: N}` sets
 * it explicitly. Normalized to the object form so consumers see one shape.
 */
const loopbackSchema = z
  .union([
    z.literal(true),
    z.strictObject({
      maxAttempts: z.number().int().min(1).default(DEFAULT_LOOPBACK_MAX_ATTEMPTS),
    }),
  ])
  .transform((v) => (v === true ? { maxAttempts: DEFAULT_LOOPBACK_MAX_ATTEMPTS } : v));

/**
 * Edges declare structure, never behavior: `from` and `to`, plus — for a
 * loop-back — that the edge is a return path and how many attempts it allows.
 * Whether a node failed is the node type's call; a loop-back edge only says
 * where that failure routes. Enforced by strictObject.
 */
export const edgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  loopback: loopbackSchema.optional(),
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
