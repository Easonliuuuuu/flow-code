import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getNodeType } from '../registry/index.js';
import { parseCondition } from './condition.js';
import { Graph, GraphCycleError } from './graph.js';
import { DEFAULT_SETTINGS, workflowFileSchema, } from './schema.js';
export const WORKFLOW_RELATIVE_PATH = '.flow-code/workflow.yaml';
export class WorkflowValidationError extends Error {
    problems;
    constructor(problems) {
        super(`invalid workflow:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
        this.problems = problems;
        this.name = 'WorkflowValidationError';
    }
}
function describeZodIssues(prefix, error) {
    return error.issues.map((issue) => {
        const path = issue.path.length > 0 ? ` at \`${issue.path.join('.')}\`` : '';
        return `${prefix}${path}: ${issue.message}`;
    });
}
export function loadWorkflowFromString(source) {
    let raw;
    try {
        raw = parseYaml(source);
    }
    catch (err) {
        throw new WorkflowValidationError([
            `workflow file is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
        ]);
    }
    const fileResult = workflowFileSchema.safeParse(raw);
    if (!fileResult.success) {
        const problems = fileResult.error.issues.map((issue) => {
            const [head, index, ...rest] = issue.path;
            // Name the offending edge or setting rather than a bare path.
            if (head === 'edges' && typeof index === 'number') {
                const edges = raw?.edges;
                const edge = edges?.[index];
                const label = edge && (edge.from !== undefined || edge.to !== undefined)
                    ? `edge ${String(edge.from)} -> ${String(edge.to)}`
                    : `edge #${index}`;
                const field = rest.length > 0 ? ` (\`${rest.join('.')}\`)` : '';
                return `${label}${field}: ${issue.message}`;
            }
            if (head === 'settings') {
                const field = [index, ...rest].filter((p) => p !== undefined).join('.');
                return `settings${field ? ` \`${field}\`` : ''}: ${issue.message}`;
            }
            const path = issue.path.length > 0 ? ` at \`${issue.path.join('.')}\`` : '';
            return `workflow file${path}: ${issue.message}`;
        });
        throw new WorkflowValidationError(problems);
    }
    const file = fileResult.data;
    const problems = [];
    // Node ids must be unique.
    const seenIds = new Set();
    for (const node of file.nodes) {
        if (seenIds.has(node.id))
            problems.push(`node \`${node.id}\`: duplicate node id`);
        seenIds.add(node.id);
    }
    // Node type must exist in the registry; config must satisfy its schema.
    const nodes = [];
    for (const node of file.nodes) {
        const type = getNodeType(node.type);
        if (!type) {
            problems.push(`node \`${node.id}\`: unknown node type \`${node.type}\``);
            continue;
        }
        const configResult = type.configSchema.safeParse(node.config ?? {});
        if (!configResult.success) {
            problems.push(...describeZodIssues(`node \`${node.id}\` (${type.id}) config`, configResult.error));
            continue;
        }
        nodes.push({ id: node.id, type, config: configResult.data });
    }
    // Edges must reference declared nodes.
    for (const edge of file.edges) {
        for (const end of ['from', 'to']) {
            if (!seenIds.has(edge[end])) {
                problems.push(`edge ${edge.from} -> ${edge.to}: \`${end}\` references unknown node \`${edge[end]}\``);
            }
        }
        // A `when:` is parsed here so a typo fails the load rather than becoming an
        // edge that quietly never carries.
        if (edge.when !== undefined) {
            if (edge.loopback) {
                problems.push(`edge ${edge.from} -> ${edge.to}: a loop-back cannot carry a \`when\` — a return path is taken because \`${edge.from}\` failed, and that is its condition`);
            }
            try {
                parseCondition(edge.when);
            }
            catch (err) {
                problems.push(`edge ${edge.from} -> ${edge.to} (\`when\`): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    if (problems.length > 0)
        throw new WorkflowValidationError(problems);
    const graph = new Graph(nodes.map((n) => n.id), file.edges);
    let order;
    try {
        order = graph.topologicalOrder();
    }
    catch (err) {
        if (err instanceof GraphCycleError) {
            throw new WorkflowValidationError([err.message]);
        }
        throw err;
    }
    // A loop-back must point backwards over the forward-edge subgraph. Without
    // this the reset scope — the nodes between target and source — is undefined.
    const loopbackProblems = [];
    for (const loop of graph.allLoopbacks()) {
        if (loop.from === loop.to) {
            loopbackProblems.push(`edge ${loop.from} -> ${loop.to}: a loop-back cannot point at its own source`);
            continue;
        }
        if (!graph.ancestorsOf(loop.from).has(loop.to)) {
            loopbackProblems.push(`edge ${loop.from} -> ${loop.to}: a loop-back must point back to a node upstream of \`${loop.from}\`, and \`${loop.to}\` is not`);
        }
    }
    if (loopbackProblems.length > 0)
        throw new WorkflowValidationError(loopbackProblems);
    // A condition may only read a node whose output is guaranteed to exist by
    // the time the edge is evaluated: the edge's own source, or an ancestor of
    // it. Anything else is a race the graph cannot honour.
    const conditionProblems = [];
    for (const { from, to, condition } of graph.allConditionals()) {
        const label = `edge ${from} -> ${to} (\`when: ${condition.source}\`)`;
        if (!seenIds.has(condition.nodeId)) {
            conditionProblems.push(`${label}: references unknown node \`${condition.nodeId}\``);
            continue;
        }
        if (condition.nodeId !== from && !graph.ancestorsOf(from).has(condition.nodeId)) {
            conditionProblems.push(`${label}: can only read \`${from}\` or a node upstream of it, and \`${condition.nodeId}\` is neither — its output may not exist yet when this edge is evaluated`);
        }
    }
    if (conditionProblems.length > 0)
        throw new WorkflowValidationError(conditionProblems);
    return {
        settings: file.settings ?? DEFAULT_SETTINGS,
        nodes,
        edges: file.edges,
        graph,
        order,
    };
}
export function loadWorkflow(repoRoot) {
    const path = join(repoRoot, WORKFLOW_RELATIVE_PATH);
    let source;
    try {
        source = readFileSync(path, 'utf8');
    }
    catch {
        throw new WorkflowValidationError([
            `no workflow file found at ${path} — run \`flow-code init\` to scaffold one`,
        ]);
    }
    return loadWorkflowFromString(source);
}
//# sourceMappingURL=load.js.map