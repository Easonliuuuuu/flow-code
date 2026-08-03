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
export const budgetSchema = z.strictObject({
    /** Tokens one node may consume across all of its attempts. */
    tokensPerNode: z.number().int().min(1).optional(),
    /** Tokens the whole run may consume. */
    tokensPerRun: z.number().int().min(1).optional(),
    /** Wall-clock minutes the whole run may take. */
    minutesPerRun: z.number().min(0.1).optional(),
});
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
export const nodeBudgetSchema = z.strictObject({
    /** Tokens this node may consume across all of its attempts. */
    tokens: z.number().int().min(1).optional(),
});
export const settingsSchema = z.strictObject({
    concurrency: z.number().int().min(1).max(16).default(2),
    model: z.string().min(1).optional(),
    budget: budgetSchema.optional(),
});
export const DEFAULT_SETTINGS = settingsSchema.parse({});
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
    /**
     * Routing condition (see condition.ts): the edge only carries when it holds,
     * and its target is skipped when it does not. Parsed at load time, so a
     * malformed condition is a validation error rather than an edge that
     * silently never fires. Not meaningful on a loop-back — a return path is
     * taken because a node failed, which is the condition.
     */
    when: z.string().min(1).optional(),
});
export const nodeEntrySchema = z.strictObject({
    id: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'node ids must be alphanumeric with - or _'),
    type: z.string().min(1),
    budget: nodeBudgetSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
});
export const workflowFileSchema = z.strictObject({
    settings: settingsSchema.optional(),
    nodes: z.array(nodeEntrySchema).min(1),
    edges: z.array(edgeSchema).default([]),
});
//# sourceMappingURL=schema.js.map