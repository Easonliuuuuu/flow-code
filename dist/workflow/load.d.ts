import { type NodeTypeDefinition } from '../registry/index.js';
import { Graph } from './graph.js';
import { type RunSettings, type WorkflowEdge } from './schema.js';
export declare const WORKFLOW_RELATIVE_PATH = ".flow-code/workflow.yaml";
export interface WorkflowNode {
    id: string;
    type: NodeTypeDefinition;
    /** Config validated against the type's schema (defaults applied). */
    config: unknown;
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
export declare function loadWorkflowFromString(source: string): Workflow;
export declare function loadWorkflow(repoRoot: string): Workflow;
