import { z } from 'zod';
/**
 * Run-wide settings. Documented defaults:
 *  - concurrency: 2 — max concurrently running agent sessions across the run
 *  - model: unset — each session falls back to the Claude Agent SDK's default
 */
/**
 * Stop rules. A workflow that can retry is a workflow that can spend without
 * bound, so a run gets to say how much it is allowed to cost before it is
 * stopped — in tokens, per node and overall, and in wall-clock minutes.
 *
 * Every field is optional and unset means unbounded: an existing workflow
 * keeps behaving exactly as it did. Scaffolded workflows come with real
 * numbers, because "no ceiling" is a bad default to hand someone new.
 *
 * A budget stop is deliberately final — it never triggers a loop-back retry.
 * Retrying past a ceiling is precisely what the ceiling exists to prevent.
 */
export declare const budgetSchema: z.ZodObject<{
    tokensPerNode: z.ZodOptional<z.ZodNumber>;
    tokensPerRun: z.ZodOptional<z.ZodNumber>;
    minutesPerRun: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type RunBudget = z.infer<typeof budgetSchema>;
/**
 * One node's own ceiling, overriding `settings.budget.tokensPerNode` for it
 * alone. A run-wide per-node number has to be set for the most expensive
 * node in the graph, which leaves every cheap node effectively unbounded;
 * this is how a single known-expensive (or known-cheap) node gets a limit
 * that fits it.
 *
 * A sibling of `config` rather than a field inside it: the budget is enforced
 * by the engine and means the same thing for every node type, so it has no
 * business in a schema each type validates for itself.
 */
export declare const nodeBudgetSchema: z.ZodObject<{
    tokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type NodeBudget = z.infer<typeof nodeBudgetSchema>;
export declare const settingsSchema: z.ZodObject<{
    concurrency: z.ZodDefault<z.ZodNumber>;
    model: z.ZodOptional<z.ZodString>;
    budget: z.ZodOptional<z.ZodObject<{
        tokensPerNode: z.ZodOptional<z.ZodNumber>;
        tokensPerRun: z.ZodOptional<z.ZodNumber>;
        minutesPerRun: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
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
    when: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export declare const nodeEntrySchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodString;
    budget: z.ZodOptional<z.ZodObject<{
        tokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export declare const workflowFileSchema: z.ZodObject<{
    settings: z.ZodOptional<z.ZodObject<{
        concurrency: z.ZodDefault<z.ZodNumber>;
        model: z.ZodOptional<z.ZodString>;
        budget: z.ZodOptional<z.ZodObject<{
            tokensPerNode: z.ZodOptional<z.ZodNumber>;
            tokensPerRun: z.ZodOptional<z.ZodNumber>;
            minutesPerRun: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        type: z.ZodString;
        budget: z.ZodOptional<z.ZodObject<{
            tokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
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
        when: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type WorkflowFileRaw = z.infer<typeof workflowFileSchema>;
