import { z } from 'zod';
import type { NodeTypeDefinition, NodeTypeId } from './types.js';
export type { NodeTypeDefinition, NodeTypeId } from './types.js';
export { NODE_TYPE_IDS } from './types.js';
declare const discussConfig: z.ZodObject<{
    topic: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/**
 * A Spec node either derives the spec from upstream context (no fields set,
 * the agent writes it) or is handed one outright. Supplying
 * `acceptanceCriteria` in config skips the agent session entirely — a spec
 * you already know is not worth paying a model to restate.
 */
declare const specConfig: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    requirements: z.ZodOptional<z.ZodArray<z.ZodString>>;
    acceptanceCriteria: z.ZodOptional<z.ZodArray<z.ZodString>>;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
declare const implementConfig: z.ZodObject<{
    instructions: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/**
 * Either an explicit command list or `auto`. `auto` opts the node into
 * rediscovering its commands at the start of each execution, trading the
 * deterministic-verdict guarantee for convenience; the loader rejects it in
 * combination with a loop-back that can re-run the node, which is the
 * combination that lets a retry loop shop for an easier suite.
 */
export declare const TEST_COMMANDS_AUTO = "auto";
declare const testConfig: z.ZodObject<{
    commands: z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodLiteral<"auto">]>;
}, z.core.$strict>;
declare const validateConfig: z.ZodObject<{
    instructions: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
declare const reviewConfig: z.ZodObject<{
    instructions: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/**
 * Git-ops config: commit-only by default. Pushing is opt-in and requires an
 * explicit remote and branch — a push node with either missing fails at load
 * time, not at the moment of pushing.
 */
declare const gitOpsConfig: z.ZodObject<{
    commitMessage: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    push: z.ZodOptional<z.ZodObject<{
        remote: z.ZodString;
        branch: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const worktreeAgentConfig: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"compare">;
    task: z.ZodString;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    instances: z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        instructions: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"parallelize">;
    model: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    instances: z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        task: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>], "mode">;
declare const approvalGateConfig: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const discussOutput: z.ZodObject<{
    conclusion: z.ZodString;
    constraints: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/** One testable statement the run is finished against. */
export declare const acceptanceCriterion: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
}, z.core.$strip>;
export declare const specOutput: z.ZodObject<{
    specPath: z.ZodString;
    title: z.ZodString;
    requirements: z.ZodArray<z.ZodString>;
    acceptanceCriteria: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const implementOutput: z.ZodObject<{
    changedFiles: z.ZodArray<z.ZodString>;
    diff: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const testOutput: z.ZodObject<{
    passed: z.ZodBoolean;
    commands: z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        exitStatus: z.ZodNullable<z.ZodNumber>;
        output: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const validateOutput: z.ZodObject<{
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
    }>;
    notes: z.ZodString;
    criteria: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        met: z.ZodBoolean;
        evidence: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const reviewOutput: z.ZodObject<{
    verdict: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
    }>;
    findings: z.ZodArray<z.ZodObject<{
        location: z.ZodString;
        description: z.ZodString;
        severity: z.ZodOptional<z.ZodEnum<{
            info: "info";
            minor: "minor";
            major: "major";
        }>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const gitOpsOutput: z.ZodObject<{
    committed: z.ZodBoolean;
    commit: z.ZodOptional<z.ZodString>;
    pushed: z.ZodBoolean;
    remote: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const worktreeAgentOutput: z.ZodObject<{
    mode: z.ZodEnum<{
        compare: "compare";
        parallelize: "parallelize";
    }>;
    branches: z.ZodArray<z.ZodObject<{
        instanceId: z.ZodString;
        branch: z.ZodString;
        status: z.ZodEnum<{
            error: "error";
            done: "done";
        }>;
        summary: z.ZodString;
        diffSummary: z.ZodString;
    }, z.core.$strip>>;
    selected: z.ZodArray<z.ZodString>;
    convergedDir: z.ZodString;
}, z.core.$strip>;
export declare const approvalGateOutput: z.ZodObject<{
    decision: z.ZodEnum<{
        approved: "approved";
        rejected: "rejected";
    }>;
    decidedAt: z.ZodString;
}, z.core.$strip>;
export type DiscussOutput = z.infer<typeof discussOutput>;
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
export type SpecConfig = z.infer<typeof specConfig>;
export type ImplementConfig = z.infer<typeof implementConfig>;
export type TestConfig = z.infer<typeof testConfig>;
export type ValidateConfig = z.infer<typeof validateConfig>;
export type ReviewConfig = z.infer<typeof reviewConfig>;
export type GitOpsConfig = z.infer<typeof gitOpsConfig>;
export type WorktreeAgentConfig = z.infer<typeof worktreeAgentConfig>;
export type ApprovalGateConfig = z.infer<typeof approvalGateConfig>;
export declare const nodeTypeRegistry: ReadonlyMap<NodeTypeId, NodeTypeDefinition>;
export declare function getNodeType(id: string): NodeTypeDefinition | undefined;
export declare function listNodeTypes(): NodeTypeDefinition[];
