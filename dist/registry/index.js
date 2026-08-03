import { z } from 'zod';
export { NODE_TYPE_IDS } from './types.js';
// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------
/**
 * Skills attached to an agent-driven node: identifiers from a discovery root,
 * or repo-relative paths. Only agent-driven types carry this field — on a type
 * with no session there is no prompt to compose into, so `strictObject`
 * rejecting the key is the whole enforcement.
 */
const skillsField = z.array(z.string().min(1)).optional();
const discussConfig = z.strictObject({
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
            .array(z.strictObject({
            id: z.string().min(1).optional(),
            instructions: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
        }))
            .min(2),
    }),
    z.strictObject({
        mode: z.literal('parallelize'),
        model: z.string().min(1).optional(),
        skills: skillsField,
        instances: z
            .array(z.strictObject({
            id: z.string().min(1).optional(),
            task: z.string().min(1),
        }))
            .min(1),
    }),
]);
const approvalGateConfig = z.strictObject({
    title: z.string().min(1).optional(),
});
// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------
export const discussOutput = z.object({
    conclusion: z.string(),
    constraints: z.array(z.string()),
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
    commands: z.array(z.object({
        command: z.string(),
        exitStatus: z.number().nullable(),
        output: z.string(),
    })),
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
        .array(z.object({
        id: z.string(),
        met: z.boolean(),
        evidence: z.string(),
    }))
        .default([]),
});
export const reviewOutput = z.object({
    verdict: z.enum(['pass', 'fail']),
    findings: z.array(z.object({
        location: z.string(),
        description: z.string(),
        severity: z.enum(['info', 'minor', 'major']).optional(),
    })),
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
    branches: z.array(z.object({
        instanceId: z.string(),
        branch: z.string(),
        status: z.enum(['done', 'error']),
        summary: z.string(),
        diffSummary: z.string(),
    })),
    selected: z.array(z.string()),
    convergedDir: z.string(),
});
export const approvalGateOutput = z.object({
    decision: z.enum(['approved', 'rejected']),
    decidedAt: z.string(),
});
// ---------------------------------------------------------------------------
// Failure predicates
// ---------------------------------------------------------------------------
/**
 * Shared by the verification types: a `fail` verdict is a failed node, not a
 * successful node that happens to report bad news. Evaluated by the engine
 * against output already validated by the type's output schema.
 */
function failsOnFailVerdict(output) {
    return output?.verdict === 'fail';
}
// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const definitions = [
    {
        id: 'discuss',
        displayName: 'Discuss',
        description: 'Interactive discussion with the user to settle intent and constraints.',
        capabilities: ['read'],
        agentDriven: true,
        interactive: true,
        hasModelField: true,
        rolePrompt: 'You are the discussion partner at the start of a coding workflow. ' +
            'Help the user clarify what should be built and which constraints apply. ' +
            'You may read the repository to inform the discussion, but you must not change anything.',
        configSchema: discussConfig,
        outputSchema: discussOutput,
        configSummary: 'topic? (string), model? (string), skills? (string[])',
        outputSummary: 'conclusion (string), constraints (string[])',
    },
    {
        id: 'spec',
        displayName: 'Spec',
        description: 'Writes the durable spec — requirements and acceptance criteria — that the rest of the run implements and is verified against. ' +
            'The file is written by flow-code itself, not by an agent, and no node can edit it afterwards.',
        capabilities: ['read'],
        agentDriven: true,
        interactive: false,
        hasModelField: true,
        rolePrompt: 'You are the specification step of a coding workflow. ' +
            'Turn the intent in your context into a short, concrete spec: what must be true when this change is done. ' +
            'Acceptance criteria are the contract the work will be judged against, so each one must be a single, ' +
            'independently checkable statement about observable behaviour — not a task list, not a restatement of the plan. ' +
            'You may read the repository to ground the spec in what actually exists, but you must not change anything.',
        configSchema: specConfig,
        outputSchema: specOutput,
        configSummary: 'title? (string), requirements? (string[]), acceptanceCriteria? (string[]), model? (string), skills? (string[])',
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
        rolePrompt: 'You are the implementation step of a coding workflow. ' +
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
        description: 'Deterministic command runner: executes configured shell commands with no agent session and no API cost. ' +
            'It runs tests; it never writes them (the Implement step does).',
        capabilities: ['read', 'exec'],
        agentDriven: false,
        interactive: false,
        hasModelField: false,
        rolePrompt: '',
        configSchema: testConfig,
        outputSchema: testOutput,
        configSummary: "commands (string[] min 1, or 'auto' to rediscover each run)",
        outputSummary: 'passed (boolean), commands ({command, exitStatus, output}[])',
    },
    {
        id: 'validate',
        displayName: 'Validate',
        description: 'Agent-driven conformance check: does the work satisfy the task intent? Cannot edit, so it cannot fix its way to passing.',
        capabilities: ['read', 'exec'],
        agentDriven: true,
        interactive: false,
        hasModelField: true,
        rolePrompt: 'You are the validation step of a coding workflow. ' +
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
        rolePrompt: 'You are the code review step of a coding workflow. ' +
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
        description: 'Commits (and optionally pushes) what exists. Cannot edit files: it records changes, it does not author them.',
        capabilities: ['read', 'git-read', 'git-write'],
        agentDriven: true,
        interactive: false,
        hasModelField: true,
        rolePrompt: 'You are the git operations step of a coding workflow. ' +
            'Commit the pending changes exactly as they exist, with a clear commit message. ' +
            'Only push if your instructions explicitly say to, and only to the stated remote and branch. ' +
            'You cannot edit files — only git commands are available to you.',
        configSchema: gitOpsConfig,
        outputSchema: gitOpsOutput,
        configSummary: 'commitMessage? (string), push? ({remote, branch} — both required to push), skills? (string[])',
        outputSummary: 'committed (boolean), commit? (sha), pushed (boolean), remote?, branch?',
    },
    {
        id: 'worktree-agent',
        displayName: 'Worktree-Agent',
        description: 'Fans out N agent instances, each in an isolated git worktree/branch; converges by user selection.',
        capabilities: ['read', 'edit', 'exec'],
        agentDriven: true,
        interactive: false,
        hasModelField: false,
        rolePrompt: 'You are one of several parallel implementation agents, each working in an isolated git worktree. ' +
            'Carry out your assigned task within your own working directory. ' +
            'Do not perform any git operation that mutates history or remotes.',
        configSchema: worktreeAgentConfig,
        outputSchema: worktreeAgentOutput,
        configSummary: "mode ('compare': task + instances[{instructions?, model?}] | 'parallelize': instances[{task}]), skills? (string[])",
        outputSummary: 'mode, branches ({instanceId, branch, status, summary, diffSummary}[]), selected (string[]), convergedDir (string)',
    },
    {
        id: 'approval-gate',
        displayName: 'Approval-Gate',
        description: 'No agent session: computes the pending diff against the run baseline and waits for explicit user approval.',
        capabilities: [],
        agentDriven: false,
        interactive: false,
        hasModelField: false,
        rolePrompt: '',
        configSchema: approvalGateConfig,
        outputSchema: approvalGateOutput,
        configSummary: 'title? (string)',
        outputSummary: "decision ('approved'|'rejected'), decidedAt (ISO timestamp)",
        // A gate records a decision, not a result: without transparency every node
        // after a gate would receive `{decision, decidedAt}` and nothing else.
        contextTransparent: true,
    },
];
export const nodeTypeRegistry = new Map(definitions.map((d) => [d.id, d]));
export function getNodeType(id) {
    return nodeTypeRegistry.get(id);
}
export function listNodeTypes() {
    return [...nodeTypeRegistry.values()];
}
//# sourceMappingURL=index.js.map