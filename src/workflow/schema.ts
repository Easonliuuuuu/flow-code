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
export const nodeBudgetSchema = z.strictObject({
  /** Tokens this node may consume across all of its attempts. */
  tokens: z.number().int().min(1).optional(),
});

export type NodeBudget = z.infer<typeof nodeBudgetSchema>;

export const settingsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(16).default(2),
  model: z.string().min(1).optional(),
  budget: budgetSchema.optional(),
  /**
   * Whether a node's agent session may delegate to subagents. A subagent is
   * bounded by its parent node's capability set either way, so this is a lever
   * for cost and predictability rather than for safety — and the way to turn
   * delegation off on a misbehaving workflow without downgrading.
   */
  subagents: z.boolean().default(true),
});

export type RunSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: RunSettings = settingsSchema.parse({});

/** Attempts a loop-back target may take before the run gives up on it. */
export const DEFAULT_LOOPBACK_MAX_ATTEMPTS = 3;

/** What ends a node's execution and sends the run back up this return path. */
export const LOOPBACK_TRIGGERS = ['failure', 'success'] as const;
export type LoopbackTrigger = (typeof LOOPBACK_TRIGGERS)[number];

/**
 * Which outcome takes a return path. `failure` — the default, and what every
 * verification loop wants — fires when the source fails, so a failing test is
 * another iteration rather than the end of the run.
 *
 * `success` exists for the one shape where finishing *is* the signal to go
 * back: a step whose whole job is to decide what to change next, reached
 * because something upstream was rejected. Its conclusion is the reason to
 * retry, so waiting for it to fail would mean waiting forever.
 */
export const DEFAULT_LOOPBACK_TRIGGER: LoopbackTrigger = 'failure';

/**
 * `loopback: true` takes the defaults; `loopback: {maxAttempts: N, on: …}` sets
 * them explicitly. Normalized to the object form so consumers see one shape.
 */
const loopbackSchema = z.preprocess(
  // `true` is shorthand for "all defaults". Normalizing here rather than with a
  // union keeps the schema a plain object, so a bad field is reported against
  // that field — a union reports only that the whole value was invalid, which
  // for `on: sometimes` reads as "Invalid input" and names nothing.
  (v) => (v === true ? {} : v),
  z.strictObject({
    maxAttempts: z.number().int().min(1).default(DEFAULT_LOOPBACK_MAX_ATTEMPTS),
    on: z.enum(LOOPBACK_TRIGGERS).default(DEFAULT_LOOPBACK_TRIGGER),
  }),
);

/**
 * Edges declare structure, never behavior: `from` and `to`, plus — for a
 * loop-back — that the edge is a return path, how many attempts it allows, and
 * which outcome takes it. Whether a node succeeded or failed is still the node
 * type's call; a loop-back edge only says where each outcome routes. Enforced
 * by strictObject.
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
   * taken because of how its source ended, which is what `loopback.on` says.
   */
  when: z.string().min(1).optional(),
});

export type WorkflowEdge = z.infer<typeof edgeSchema>;

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

export type WorkflowFileRaw = z.infer<typeof workflowFileSchema>;

/**
 * One named shape in a `graphs:` file. `budget` is accepted structurally
 * (typed loosely, not `nodeBudgetSchema`/`budgetSchema`) so a graph carrying
 * one parses far enough for `resolveSelectedGraph` in `load.ts` to reject it
 * with a message naming the graph — a `strictObject` "unrecognized key"
 * error can't do that.
 */
export const namedGraphEntrySchema = z.strictObject({
  description: z.string().min(1).optional(),
  nodes: z.array(nodeEntrySchema).min(1),
  edges: z.array(edgeSchema).default([]),
  budget: z.unknown().optional(),
});

export type NamedGraphEntryRaw = z.infer<typeof namedGraphEntrySchema>;

/**
 * A file may declare several named graphs instead of one flat graph, with
 * `settings` still declared once, applying to whichever graph a run selects.
 * Mutually exclusive with the flat form — see `workflowDocumentSchema`.
 */
export const namedGraphsFileSchema = z.strictObject({
  settings: settingsSchema.optional(),
  graphs: z
    .record(z.string().min(1), namedGraphEntrySchema)
    .refine((graphs) => Object.keys(graphs).length > 0, {
      message: 'graphs must declare at least one named graph',
    }),
});

export type NamedGraphsFileRaw = z.infer<typeof namedGraphsFileSchema>;

export const workflowDocumentSchema = z.union([workflowFileSchema, namedGraphsFileSchema]);

export type WorkflowDocumentRaw = z.infer<typeof workflowDocumentSchema>;
