import { type NodeTypeDefinition } from '../registry/index.js';
import { type DiscoveredSkill, type SkillRoots } from '../skills/discover.js';
import { Graph } from './graph.js';
import { type RunSettings, type WorkflowEdge } from './schema.js';
export declare const WORKFLOW_RELATIVE_PATH = ".flow-code/workflow.yaml";
export interface WorkflowNode {
    id: string;
    type: NodeTypeDefinition;
    /** Config validated against the type's schema (defaults applied). */
    config: unknown;
    /**
     * Skills named in `config.skills`, resolved at load time in declaration
     * order. Resolution happens here, once, so an unresolvable skill is a
     * validation error before the run starts rather than a failure raised when
     * the node executes.
     */
    skills: DiscoveredSkill[];
}
export interface LoadOptions {
    /** Anchors repo-relative skill paths and the project skill root. */
    repoRoot?: string;
    /** Overrides the discovery roots; tests point this at a fixture tree. */
    skillRoots?: SkillRoots;
}
export interface Workflow {
    settings: RunSettings;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    graph: Graph;
    /** Node ids in topological order. */
    order: string[];
}
export declare class WorkflowValidationError extends Error {
    readonly problems: string[];
    constructor(problems: string[]);
}
export declare function loadWorkflowFromString(source: string, options?: LoadOptions): Workflow;
export declare function loadWorkflow(repoRoot: string, options?: LoadOptions): Workflow;
