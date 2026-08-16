import { z } from 'zod';
import { CAPABILITIES } from '../capabilities.js';
import { edgeSchema, nodeEntrySchema } from '../workflow/schema.js';
import type { WorkflowNode } from '../workflow/load.js';
import type { NodeTypeDefinition, NodeTypeId } from './types.js';

export type { NodeTypeDefinition, NodeTypeId } from './types.js';
export { NODE_TYPE_IDS } from './types.js';

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

/**
 * Skills attached to a node: identifiers from a discovery root, or
 * repo-relative paths. Carried by every type whose executor can spend an
 * agent session — either because the type itself is agent-driven, or (Test,
 * Approval-Gate) because `agent: true` opts that specific node into one
 * optional, capability-locked-by-default session its core execution doesn't
 * otherwise need. A type that carries neither rejects the key outright via
 * `strictObject`.
 */
const skillsField = z.array(z.string().min(1)).optional();

/**
 * The optional-agent-step fields spliced into `test`/`approval-gate`'s config
 * (see `hasOptionalAgentStep`). `agent` gates whether the step runs at all —
 * it defaults to unset/false, so an existing workflow.yaml is unaffected
 * until it opts in. `instructions` is task-specific guidance folded into the
 * step's *prompt* (the "what"), the same role `implement.config.instructions`
 * already plays; `skills` shapes the step's *role* (the "how"), exactly like
 * every other type. `capabilities` defaults to read-only when omitted, but is
 * fully configurable — a deliberate trade-off, not an oversight; see
 * `cmdDoctor`'s warning when a node configures more than that.
 */
const agentStepFields = {
  agent: z.boolean().optional(),
  instructions: z.string().min(1).optional(),
  skills: skillsField,
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
};

const discussConfig = z.strictObject({
  topic: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  skills: skillsField,
});

/**
 * Same shape as Discuss: a topic to negotiate about, nothing more. What
 * distinguishes Plan is not its config but its output — a graph rather than
 * a conclusion.
 */
const planConfig = z.strictObject({
  topic: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  skills: skillsField,
});

/**
 * A Spec node either derives the spec from upstream context (no fields set,
 * the agent writes it) or is handed one outright. Supplying
 * `acceptanceCriteria` in config skips the agent session entirely — a spec
 * you already know is not worth paying a model to restate.
 */
const specConfig = z.strictObject({
  title: z.string().min(1).optional(),
  requirements: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  skills: skillsField,
});

const implementConfig = z.strictObject({
  instructions: z.string().min(1),
  model: z.string().min(1).optional(),
  skills: skillsField,
});

/**
 * Either an explicit command list or `auto`. `auto` opts the node into
 * rediscovering its commands at the start of each execution, trading the
 * deterministic-verdict guarantee for convenience; the loader rejects it in
 * combination with a loop-back that can re-run the node, which is the
 * combination that lets a retry loop shop for an easier suite.
 */
export const TEST_COMMANDS_AUTO = 'auto';

/**
 * The single command every scaffolded Test node starts with, before a real
 * one is filled in. Exported rather than duplicated as a literal in
 * defaultWorkflow.ts/presets.ts (which use it verbatim in their YAML) and in
 * `cmdRun` (which matches on it to know a node was never actually
 * configured, and offers to resolve it there instead of failing on it).
 */
export const PLACEHOLDER_TEST_COMMAND = 'echo "replace me with your project\'s test command"';

const testConfig = z.strictObject({
  commands: z.union([z.array(z.string().min(1)).min(1), z.literal(TEST_COMMANDS_AUTO)]),
  ...agentStepFields,
});

const validateConfig = z.strictObject({
  instructions: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  skills: skillsField,
});

const reviewConfig = z.strictObject({
  instructions: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  skills: skillsField,
});

/**
 * Git-ops config: commit-only by default. Pushing is opt-in and requires an
 * explicit remote and branch — a push node with either missing fails at load
 * time, not at the moment of pushing.
 */
const gitOpsConfig = z.strictObject({
  commitMessage: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  skills: skillsField,
  push: z
    .strictObject({
      remote: z.string().min(1),
      branch: z.string().min(1),
    })
    .optional(),
});

const worktreeAgentConfig = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('compare'),
    task: z.string().min(1),
    skills: skillsField,
    instances: z
      .array(
        z.strictObject({
          id: z.string().min(1).optional(),
          instructions: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
        }),
      )
      .min(2),
  }),
  z.strictObject({
    mode: z.literal('parallelize'),
    model: z.string().min(1).optional(),
    skills: skillsField,
    instances: z
      .array(
        z.strictObject({
          id: z.string().min(1).optional(),
          task: z.string().min(1),
        }),
      )
      .min(1),
  }),
]);

const approvalGateConfig = z.strictObject({
  title: z.string().min(1).optional(),
  ...agentStepFields,
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

export const discussOutput = z.object({
  conclusion: z.string(),
  constraints: z.array(z.string()),
});

/**
 * A proposed graph, in exactly the shape a workflow file's `nodes`/`edges`
 * are — reusing `nodeEntrySchema`/`edgeSchema` rather than a bespoke shape is
 * what keeps "planning composes only existing node types" true structurally:
 * there is no separate vocabulary a proposal could drift into.
 */
export const planOutput = z.object({
  nodes: z.array(nodeEntrySchema).min(1),
  edges: z.array(edgeSchema).default([]),
});

/** One testable statement the run is finished against. */
export const acceptanceCriterion = z.object({
  /** Stable within a run (`AC1`, `AC2`, …) so downstream nodes can cite it. */
  id: z.string(),
  text: z.string(),
});

export const specOutput = z.object({
  /** Repo-relative path of the written spec, for a human to open or commit. */
  specPath: z.string(),
  title: z.string(),
  requirements: z.array(z.string()),
  acceptanceCriteria: z.array(acceptanceCriterion),
});

export const implementOutput = z.object({
  changedFiles: z.array(z.string()),
  diff: z.string(),
  summary: z.string().optional(),
});

export const testOutput = z.object({
  passed: z.boolean(),
  commands: z.array(
    z.object({
      command: z.string(),
      exitStatus: z.number().nullable(),
      output: z.string(),
    }),
  ),
  /** Set only when `agent`/`skills` were configured — never influences `passed`. */
  analysis: z.string().optional(),
});

export const validateOutput = z.object({
  verdict: z.enum(['pass', 'fail']),
  notes: z.string(),
  /**
   * One entry per acceptance criterion in scope, when an upstream Spec node
   * supplied any. This is what turns validation from an opinion into a
   * checklist: the verdict is then computed from the entries rather than
   * asserted, so a model cannot pass a run whose criteria are unmet.
   */
  criteria: z
    .array(
      z.object({
        id: z.string(),
        met: z.boolean(),
        evidence: z.string(),
      }),
    )
    .default([]),
});

export const reviewOutput = z.object({
  verdict: z.enum(['pass', 'fail']),
  findings: z.array(
    z.object({
      location: z.string(),
      description: z.string(),
      severity: z.enum(['info', 'minor', 'major']).optional(),
    }),
  ),
});

export const gitOpsOutput = z.object({
  committed: z.boolean(),
  commit: z.string().optional(),
  pushed: z.boolean(),
  remote: z.string().optional(),
  branch: z.string().optional(),
});

export const worktreeAgentOutput = z.object({
  mode: z.enum(['compare', 'parallelize']),
  branches: z.array(
    z.object({
      instanceId: z.string(),
      branch: z.string(),
      status: z.enum(['done', 'error']),
      summary: z.string(),
      diffSummary: z.string(),
    }),
  ),
  selected: z.array(z.string()),
  convergedDir: z.string(),
});

/**
 * `diffs` is what the decision was made on, kept so the decision stays
 * reviewable after the fact and so a node downstream of the gate receives the
 * changes rather than the bare verdict. Optional because the guest path records
 * a decision it did not compute a diff for.
 */
export const approvalGateOutput = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedAt: z.string(),
  diffs: z.array(z.object({ label: z.string().optional(), diff: z.string() })).optional(),
});

export type DiscussOutput = z.infer<typeof discussOutput>;
export type PlanOutput = z.infer<typeof planOutput>;
export type SpecOutput = z.infer<typeof specOutput>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterion>;
export type ImplementOutput = z.infer<typeof implementOutput>;
export type TestOutput = z.infer<typeof testOutput>;
export type ValidateOutput = z.infer<typeof validateOutput>;
export type ReviewOutput = z.infer<typeof reviewOutput>;
export type GitOpsOutput = z.infer<typeof gitOpsOutput>;
export type WorktreeAgentOutput = z.infer<typeof worktreeAgentOutput>;
export type ApprovalGateOutput = z.infer<typeof approvalGateOutput>;

export type DiscussConfig = z.infer<typeof discussConfig>;
export type PlanConfig = z.infer<typeof planConfig>;
export type SpecConfig = z.infer<typeof specConfig>;
export type ImplementConfig = z.infer<typeof implementConfig>;
export type TestConfig = z.infer<typeof testConfig>;
export type ValidateConfig = z.infer<typeof validateConfig>;
export type ReviewConfig = z.infer<typeof reviewConfig>;
export type GitOpsConfig = z.infer<typeof gitOpsConfig>;
export type WorktreeAgentConfig = z.infer<typeof worktreeAgentConfig>;
export type ApprovalGateConfig = z.infer<typeof approvalGateConfig>;

// ---------------------------------------------------------------------------
// Failure predicates
// ---------------------------------------------------------------------------

/**
 * Shared by the verification types: a `fail` verdict is a failed node, not a
 * successful node that happens to report bad news. Evaluated by the engine
 * against output already validated by the type's output schema.
 */
function failsOnFailVerdict(output: unknown): boolean {
  return (output as { verdict?: string } | undefined)?.verdict === 'fail';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const definitions: NodeTypeDefinition[] = [
  {
    id: 'discuss',
    displayName: 'Discuss',
    description: 'Interactive discussion with the user to settle intent and constraints.',
    capabilities: ['read'],
    agentDriven: true,
    interactive: true,
    hasModelField: true,
    // Deliberately says nothing about *where* in the workflow this runs: the
    // same type also serves as the revision step a rejected gate routes to,
    // where "at the start" would be false.
    rolePrompt:
      'You are the discussion partner in a coding workflow. ' +
      'Help the user clarify what should be built and which constraints apply. ' +
      'You may read the repository to inform the discussion, but you must not change anything.',
    configSchema: discussConfig,
    outputSchema: discussOutput,
    configSummary: 'topic? (string), model? (string), skills? (string[])',
    outputSummary: 'conclusion (string), constraints (string[])',
  },
  {
    id: 'plan',
    displayName: 'Plan',
    description:
      'Interactive negotiation of both the task and the graph that carries it out. ' +
      'Does not complete until the user accepts a proposed graph; its output is a set of ' +
      'nodes and edges, spliced into the run in place of this node\'s own successors, rather ' +
      'than text for a downstream node to read.',
    capabilities: ['read'],
    agentDriven: true,
    interactive: true,
    hasModelField: true,
    rolePrompt:
      'You are the planning step of a coding workflow. ' +
      'Talk with the user to settle what should be built, then propose a graph of nodes and ' +
      'edges — drawn only from the built-in node types you are given — that carries it out. ' +
      'You may read the repository to inform the plan, but you must not change anything. ' +
      'The graph you propose is not adopted until the user explicitly accepts it.',
    configSchema: planConfig,
    outputSchema: planOutput,
    configSummary: 'topic? (string), model? (string), skills? (string[])',
    outputSummary: 'nodes ({id, type, config?, budget?}[]), edges ({from, to, when?, loopback?}[])',
  },
  {
    id: 'spec',
    displayName: 'Spec',
    description:
      'Writes the durable spec — requirements and acceptance criteria — that the rest of the run implements and is verified against. ' +
      'The file is written by flow-code itself, not by an agent, and no node can edit it afterwards.',
    capabilities: ['read'],
    agentDriven: true,
    interactive: false,
    hasModelField: true,
    rolePrompt:
      'You are the specification step of a coding workflow. ' +
      'Turn the intent in your context into a short, concrete spec: what must be true when this change is done. ' +
      'Acceptance criteria are the contract the work will be judged against, so each one must be a single, ' +
      'independently checkable statement about observable behaviour — not a task list, not a restatement of the plan. ' +
      'You may read the repository to ground the spec in what actually exists, but you must not change anything.',
    configSchema: specConfig,
    outputSchema: specOutput,
    configSummary:
      'title? (string), requirements? (string[]), acceptanceCriteria? (string[]), model? (string), skills? (string[])',
    outputSummary: 'specPath (string), title (string), requirements (string[]), acceptanceCriteria ({id, text}[])',
  },
  {
    id: 'implement',
    displayName: 'Implement',
    description: 'Agent session that writes code for the configured task.',
    capabilities: ['read', 'edit', 'exec'],
    agentDriven: true,
    interactive: false,
    hasModelField: true,
    rolePrompt:
      'You are the implementation step of a coding workflow. ' +
      'Carry out the configured task by reading and editing files and running commands. ' +
      'You own both the production code and the tests that cover it: the downstream Test step ' +
      "is a deterministic command runner that only executes the project's existing test " +
      'commands — it cannot write or repair a test for you, so any test the change needs must ' +
      'be written here. ' +
      'Do not perform any git operation that mutates history or remotes; a later, dedicated step handles git.',
    configSchema: implementConfig,
    outputSchema: implementOutput,
    configSummary: 'instructions (string, required), model? (string), skills? (string[])',
    outputSummary: 'changedFiles (string[]), diff (string), summary? (string)',
  },
  {
    id: 'test',
    displayName: 'Test',
    description:
      'Deterministic command runner: executes configured shell commands with no agent session and no API cost. ' +
      'It runs tests; it never writes them (the Implement step does). ' +
      'Optionally, `agent: true` (with `instructions`/`skills`) adds one read-only-by-default agent pass ' +
      'after the commands finish, for analysis alongside the verdict — it can never change `passed`.',
    capabilities: ['read', 'exec'],
    agentDriven: false,
    hasOptionalAgentStep: true,
    interactive: false,
    hasModelField: false,
    rolePrompt: '',
    configSchema: testConfig,
    outputSchema: testOutput,
    configSummary:
      "commands (string[] min 1, or 'auto' to rediscover each run), agent? (boolean), instructions? (string), skills? (string[]), capabilities? (string[], default ['read'])",
    outputSummary: 'passed (boolean), commands ({command, exitStatus, output}[]), analysis? (string)',
  },
  {
    id: 'validate',
    displayName: 'Validate',
    description:
      'Agent-driven conformance check: does the work satisfy the task intent? Cannot edit, so it cannot fix its way to passing.',
    capabilities: ['read', 'exec'],
    agentDriven: true,
    interactive: false,
    hasModelField: true,
    rolePrompt:
      'You are the validation step of a coding workflow. ' +
      'Check whether the work done so far satisfies the task intent described in your context. ' +
      'You may read files and run read-only commands, but you cannot and must not modify anything — report what you find.',
    configSchema: validateConfig,
    outputSchema: validateOutput,
    configSummary: 'instructions? (string), model? (string), skills? (string[])',
    outputSummary: "verdict ('pass'|'fail'), notes (string), criteria ({id, met, evidence}[])",
    failsWhen: failsOnFailVerdict,
  },
  {
    id: 'review',
    displayName: 'Review',
    description: 'Agent-driven quality critique: findings only, no edit, no exec.',
    capabilities: ['read'],
    agentDriven: true,
    interactive: false,
    hasModelField: true,
    rolePrompt:
      'You are the code review step of a coding workflow. ' +
      'Critique the pending changes for correctness, clarity, and risk. ' +
      'You can only read; you cannot edit files or run commands. Report findings with locations.',
    configSchema: reviewConfig,
    outputSchema: reviewOutput,
    configSummary: 'instructions? (string), model? (string), skills? (string[])',
    outputSummary: "verdict ('pass'|'fail'), findings ({location, description, severity?}[])",
    failsWhen: failsOnFailVerdict,
  },
  {
    id: 'git-ops',
    displayName: 'Git-ops',
    description:
      'Commits (and optionally pushes) what exists. Cannot edit files: it records changes, it does not author them.',
    capabilities: ['read', 'git-read', 'git-write'],
    agentDriven: true,
    interactive: false,
    hasModelField: true,
    rolePrompt:
      'You are the git operations step of a coding workflow. ' +
      'Commit the pending changes exactly as they exist, with a clear commit message. ' +
      'Only push if your instructions explicitly say to, and only to the stated remote and branch. ' +
      'You cannot edit files — only git commands are available to you.',
    configSchema: gitOpsConfig,
    outputSchema: gitOpsOutput,
    configSummary:
      'commitMessage? (string), push? ({remote, branch} — both required to push), skills? (string[])',
    outputSummary: 'committed (boolean), commit? (sha), pushed (boolean), remote?, branch?',
  },
  {
    id: 'worktree-agent',
    displayName: 'Worktree-Agent',
    description:
      'Fans out N agent instances, each in an isolated git worktree/branch; converges by user selection.',
    capabilities: ['read', 'edit', 'exec'],
    agentDriven: true,
    interactive: false,
    hasModelField: false,
    rolePrompt:
      'You are one of several parallel implementation agents, each working in an isolated git worktree. ' +
      'Carry out your assigned task within your own working directory. ' +
      'Do not perform any git operation that mutates history or remotes.',
    configSchema: worktreeAgentConfig,
    outputSchema: worktreeAgentOutput,
    configSummary:
      "mode ('compare': task + instances[{instructions?, model?}] | 'parallelize': instances[{task}]), skills? (string[])",
    outputSummary:
      'mode, branches ({instanceId, branch, status, summary, diffSummary}[]), selected (string[]), convergedDir (string)',
  },
  {
    id: 'approval-gate',
    displayName: 'Approval-Gate',
    description:
      'No agent session: computes the pending diff against the run baseline and waits for explicit user approval. ' +
      'Optionally, `agent: true` (with `instructions`/`skills`) adds one read-only-by-default agent critique of ' +
      "the diff, shown to the approver alongside it — it never affects the decision itself.",
    capabilities: [],
    agentDriven: false,
    hasOptionalAgentStep: true,
    interactive: false,
    hasModelField: false,
    rolePrompt: '',
    configSchema: approvalGateConfig,
    outputSchema: approvalGateOutput,
    configSummary:
      "title? (string), agent? (boolean), instructions? (string), skills? (string[]), capabilities? (string[], default ['read'])",
    outputSummary:
      "decision ('approved'|'rejected'), decidedAt (ISO timestamp), diffs? (the changes decided on)",
    // A gate records a decision, not a result: without transparency every node
    // after a gate would receive `{decision, decidedAt}` and nothing else.
    contextTransparent: true,
  },
];

export const nodeTypeRegistry: ReadonlyMap<NodeTypeId, NodeTypeDefinition> = new Map(
  definitions.map((d) => [d.id, d]),
);

export function getNodeType(id: string): NodeTypeDefinition | undefined {
  return nodeTypeRegistry.get(id as NodeTypeId);
}

export function listNodeTypes(): NodeTypeDefinition[] {
  return [...nodeTypeRegistry.values()];
}

/**
 * The node-type reference as printed lines, one block per type. Shared by
 * `flow-code node-types` and the Plan node's prompt, so the vocabulary a
 * planner is told it may use and the vocabulary the loader actually accepts
 * cannot drift apart — both read this, not a second description of it.
 */
export function nodeTypeReferenceLines(): string[] {
  const lines: string[] = [];
  for (const type of listNodeTypes()) {
    lines.push(`${type.id}  (${type.displayName})`);
    lines.push(`  ${type.description}`);
    lines.push(
      `  capabilities: ${type.capabilities.length > 0 ? type.capabilities.join(', ') : '(none)'}`,
    );
    lines.push(
      `  agent session: ${type.agentDriven ? 'yes' : 'no'}` +
        (type.agentDriven ? ` · interactive: ${type.interactive ? 'yes' : 'no'}` : ''),
    );
    lines.push(`  config: ${type.configSummary}`);
    lines.push(`  output: ${type.outputSummary}`);
    if (type.failsWhen) {
      lines.push('  fails on: its own output verdict (a `fail` verdict errors the node)');
    }
    if (type.contextTransparent) {
      lines.push("  context: transparent — forwards its dependencies' outputs downstream");
    }
    lines.push('');
  }
  return lines;
}

/** Can this node TYPE'S config even carry the agent-step fields? Drives UI availability (skill picker, detail panel). */
export function nodeTypeAcceptsAgentStep(type: NodeTypeDefinition): boolean {
  return type.agentDriven || type.hasOptionalAgentStep === true;
}

/**
 * Will THIS node actually spend an agent session? Drives `resolveProvider`/
 * `preflight` and the executors themselves. `agentDriven` types always have;
 * for the rest, only when `agent: true` and there's actually something to run
 * it with (instructions or at least one resolved skill) — `agent: true` with
 * neither is a no-op, not an error, so it does not count as wanting a step.
 */
export function nodeWantsAgentStep(node: WorkflowNode): boolean {
  if (node.type.agentDriven) return true;
  const config = node.config as { agent?: boolean; instructions?: string };
  return config.agent === true && (config.instructions !== undefined || node.skills.length > 0);
}
