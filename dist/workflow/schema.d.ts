import { z } from 'zod';
/**
 * Run-wide settings. Documented defaults:
 *  - concurrency: 2 — max concurrently running agent sessions across the run
 *  - model: unset — each session falls back to the Claude Agent SDK's default
 */
export declare const settingsSchema: z.ZodObject<{
    concurrency: z.ZodDefault<z.ZodNumber>;
    model: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RunSettings = z.infer<typeof settingsSchema>;
export declare const DEFAULT_SETTINGS: RunSettings;
/** Attempts a loop-back target may take before the run gives up on it. */
export declare const DEFAULT_LOOPBACK_MAX_ATTEMPTS = 3;
/**
 * Edges declare structure, never behavior: `from` and `to`, plus — for a
 * loop-back — that the edge is a return path and how many attempts it allows.
 * Whether a node failed is the node type's call; a loop-back edge only says
 * where that failure routes. Enforced by strictObject.
 */
export declare const edgeSchema: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
    loopback: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodLiteral<true>, z.ZodObject<{
        maxAttempts: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>]>, z.ZodTransform<{
        maxAttempts: number;
    }, true | {
        maxAttempts: number;
    }>>>;
}, z.core.$strict>;
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export declare const nodeEntrySchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodString;
    config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export declare const workflowFileSchema: z.ZodObject<{
    settings: z.ZodOptional<z.ZodObject<{
        concurrency: z.ZodDefault<z.ZodNumber>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        type: z.ZodString;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>;
    edges: z.ZodDefault<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        loopback: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodLiteral<true>, z.ZodObject<{
            maxAttempts: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>]>, z.ZodTransform<{
            maxAttempts: number;
        }, true | {
            maxAttempts: number;
        }>>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type WorkflowFileRaw = z.infer<typeof workflowFileSchema>;
