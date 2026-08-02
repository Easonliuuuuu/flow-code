import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { capabilitySet } from '../capabilities.js';
import { addWorktree, commitAll, diffStatBetweenTrees, git, removeWorktree, } from '../git/ops.js';
import { nodeModel, truncateText, upstreamPreamble } from './helpers.js';
function instancePrompt(ctx, config, index) {
    const preamble = upstreamPreamble(ctx.upstream);
    if (config.mode === 'compare') {
        const instance = config.instances[index];
        const instanceId = instance.id ?? `alt-${index + 1}`;
        // Compare mode: same base task for every instance, plus its own override.
        const override = instance.instructions
            ? `\n\n## Approach for this instance\n\n${instance.instructions}`
            : '';
        return {
            instanceId,
            prompt: `${preamble}## Task\n\n${config.task}${override}`,
            ...(nodeModel(ctx, instance.model) !== undefined
                ? { model: nodeModel(ctx, instance.model) }
                : {}),
        };
    }
    const instance = config.instances[index];
    const instanceId = instance.id ?? `task-${index + 1}`;
    // Parallelize mode: each instance gets exactly one distinct sub-task.
    return {
        instanceId,
        prompt: `${preamble}## Your sub-task\n\n${instance.task}`,
        ...(nodeModel(ctx, config.model) !== undefined ? { model: nodeModel(ctx, config.model) } : {}),
    };
}
export class ConvergenceConflictError extends Error {
    conflictingFiles;
    constructor(conflictingFiles) {
        super(`merge conflict at convergence in: ${conflictingFiles.join(', ')}`);
        this.conflictingFiles = conflictingFiles;
        this.name = 'ConvergenceConflictError';
    }
}
export const executeWorktreeAgent = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    const runShort = ctx.runId.slice(0, 8);
    const results = [];
    const runInstance = async (index) => {
        const { instanceId, prompt, model } = instancePrompt(ctx, config, index);
        const branch = `flow-code/${runShort}/${ctx.node.id}/${instanceId}`;
        const dir = join(ctx.repoRoot, '.flow-code', 'worktrees', `${runShort}-${ctx.node.id}-${instanceId}`);
        mkdirSync(dirname(dir), { recursive: true });
        await addWorktree(ctx.repoRoot, dir, branch, ctx.baseline.commit);
        ctx.store.addWorktree({
            nodeId: ctx.node.id,
            instanceId,
            branch,
            dir,
            removed: false,
            converged: false,
        });
        // Instances are the only concurrent executions; each takes a session slot.
        const release = await ctx.acquireSessionSlot();
        try {
            ctx.store.appendLiveOutput(ctx.node.id, `[${instanceId}] started in ${dir}\n`);
            const { finalText } = await ctx.sessions.run({
                nodeId: ctx.node.id,
                instanceId,
                capabilities: capabilitySet(...ctx.node.type.capabilities),
                rolePrompt: ctx.node.type.rolePrompt,
                prompt,
                workingDir: dir,
                ...(model !== undefined ? { model } : {}),
                onText: (t) => ctx.store.appendLiveOutput(ctx.node.id, `[${instanceId}] ${t}\n`),
                signal: ctx.signal,
            }, ctx.store);
            // flow-code (not the capability-bound agent) commits the instance's work.
            await commitAll(dir, `flow-code: ${ctx.node.id}/${instanceId}`);
            const tree = await git(['rev-parse', `${branch}^{tree}`], ctx.repoRoot);
            const diffSummary = await diffStatBetweenTrees(ctx.repoRoot, ctx.baseline.tree, tree);
            results.push({
                instanceId,
                branch,
                dir,
                status: 'done',
                summary: truncateText(finalText, 1000),
                diffSummary,
            });
        }
        catch (err) {
            results.push({
                instanceId,
                branch,
                dir,
                status: 'error',
                summary: err instanceof Error ? err.message : String(err),
                diffSummary: '',
            });
        }
        finally {
            release();
        }
    };
    await Promise.all(config.instances.map((_, i) => runInstance(i)));
    results.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    if (results.every((r) => r.status === 'error')) {
        throw new Error(`all worktree instances failed: ${results.map((r) => `${r.instanceId}: ${r.summary}`).join('; ')}`);
    }
    // Convergence: downstream nodes stay blocked until the user selects.
    yield { type: 'status', status: 'waiting', detail: 'awaiting convergence selection' };
    const selected = await ctx.ports.convergence.select({
        nodeId: ctx.node.id,
        mode: config.mode,
        branches: results.map(({ instanceId, branch, status, summary, diffSummary }) => ({
            instanceId,
            branch,
            status,
            summary,
            diffSummary,
        })),
    });
    const selectable = new Set(results.filter((r) => r.status === 'done').map((r) => r.instanceId));
    if (config.mode === 'compare' && selected.length !== 1) {
        throw new Error(`compare mode requires selecting exactly one branch (got ${selected.length})`);
    }
    if (selected.length === 0) {
        throw new Error('convergence requires selecting at least one branch');
    }
    for (const id of selected) {
        if (!selectable.has(id))
            throw new Error(`selected instance ${id} did not complete`);
    }
    yield { type: 'status', status: 'running', detail: 'converging' };
    const selectedResults = selected.map((id) => results.find((r) => r.instanceId === id));
    const convergence = selectedResults[0];
    // Parallelize mode with several selections: merge them; a conflict fails
    // the node rather than being silently resolved.
    for (const other of selectedResults.slice(1)) {
        try {
            await git([
                '-c',
                'user.name=flow-code',
                '-c',
                'user.email=flow-code@localhost',
                'merge',
                '--no-ff',
                '-m',
                `flow-code: merge ${other.branch}`,
                other.branch,
            ], convergence.dir);
        }
        catch {
            const conflictOut = await git(['diff', '--name-only', '--diff-filter=U'], convergence.dir);
            const conflicting = conflictOut.length === 0 ? ['(unknown)'] : conflictOut.split('\n');
            try {
                await git(['merge', '--abort'], convergence.dir);
            }
            catch {
                // no merge in progress to abort
            }
            throw new ConvergenceConflictError(conflicting);
        }
    }
    // The converged directory becomes downstream's working directory; its
    // worktree is retained until the run ends. Non-selected worktrees go now
    // (their branches are kept — the work stays reachable).
    ctx.store.updateWorktree(convergence.dir, { converged: true });
    for (const result of results) {
        if (result.dir === convergence.dir)
            continue;
        try {
            await removeWorktree(ctx.repoRoot, result.dir);
            ctx.store.updateWorktree(result.dir, { removed: true });
        }
        catch (err) {
            ctx.store.appendLiveOutput(ctx.node.id, `warning: could not remove worktree ${result.dir}: ${err instanceof Error ? err.message : err}\n`);
        }
    }
    yield {
        type: 'result',
        output: {
            mode: config.mode,
            branches: results.map(({ instanceId, branch, status, summary, diffSummary }) => ({
                instanceId,
                branch,
                status,
                summary,
                diffSummary,
            })),
            selected,
            convergedDir: convergence.dir,
        },
    };
    yield { type: 'status', status: 'done' };
};
//# sourceMappingURL=worktree.js.map