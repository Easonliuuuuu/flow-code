import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { capabilitySet } from '../capabilities.js';
import { nodeModel, parseNodeOutput, rolePromptFor, upstreamPreamble } from './helpers.js';
import { z } from 'zod';
/** Where a run's spec lives, relative to the repository root. */
export function specRelativePath(runId) {
    return join('.flow-code', 'specs', `${runId}.md`);
}
/** Criterion ids are positional and stable within a run, so nodes can cite them. */
function withIds(texts) {
    return texts.map((text, i) => ({ id: `AC${i + 1}`, text }));
}
const agentSpec = z.object({
    title: z.string().min(1),
    requirements: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).min(1),
});
function renderSpec(runId, title, requirements, criteria) {
    const lines = [
        `# ${title}`,
        '',
        `<!-- Written by flow-code for run ${runId}. Nodes in this run cannot edit this file. -->`,
        '',
        '## Requirements',
        '',
        ...(requirements.length > 0
            ? requirements.map((r) => `- ${r}`)
            : ['_None stated beyond the acceptance criteria below._']),
        '',
        '## Acceptance criteria',
        '',
        'The run is finished when every one of these holds.',
        '',
        ...criteria.map((c) => `- **${c.id}** — ${c.text}`),
        '',
    ];
    return lines.join('\n');
}
/**
 * Turns intent into the run's contract: a spec file on disk, plus acceptance
 * criteria that flow downstream as context and that the Validate node checks
 * one by one.
 *
 * The file is written here, by flow-code, rather than by an agent with edit
 * capability — and the harness refuses every node write into `.flow-code`. A
 * spec a node could rewrite would be a spec that gets rewritten to whatever
 * the run managed to achieve.
 */
export const executeSpec = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    let title;
    let requirements;
    let criteria;
    if (config.acceptanceCriteria !== undefined && config.acceptanceCriteria.length > 0) {
        // Hand-written spec: nothing to ask a model, so nothing is spent.
        title = config.title ?? 'Specification';
        requirements = config.requirements ?? [];
        criteria = withIds(config.acceptanceCriteria);
    }
    else {
        const prompt = `${upstreamPreamble(ctx.upstream)}## Specification task\n\n` +
            `Write the spec this change will be implemented from and judged against.\n` +
            (config.title ? `The change is titled: ${config.title}\n` : '') +
            (config.requirements?.length
                ? `These requirements are already fixed and must appear as-is:\n${config.requirements
                    .map((r) => `- ${r}`)
                    .join('\n')}\n`
                : '') +
            `\nEach acceptance criterion must be independently checkable by someone reading the repository ` +
            `after the work is done — a statement about observable behaviour, not a task. ` +
            `Prefer few and sharp over many and vague.\n\n` +
            `Respond with ONLY a JSON object:\n` +
            `{"title": "<short title>", "requirements": ["<requirement>", …], "acceptanceCriteria": ["<criterion>", …]}`;
        const release = await ctx.acquireSessionSlot();
        let finalText;
        try {
            const result = await ctx.sessions.run({
                nodeId: ctx.node.id,
                capabilities: capabilitySet(...ctx.node.type.capabilities),
                rolePrompt: rolePromptFor(ctx),
                prompt,
                workingDir: ctx.workingDir,
                ...(nodeModel(ctx, config.model) !== undefined
                    ? { model: nodeModel(ctx, config.model) }
                    : {}),
                onText: (t) => ctx.store.appendLiveOutput(ctx.node.id, t + '\n'),
                signal: ctx.signal,
            }, ctx.store);
            finalText = result.finalText;
        }
        finally {
            release();
        }
        const parsed = parseNodeOutput(ctx, agentSpec, finalText);
        title = config.title ?? parsed.title;
        // Fixed requirements stay first and stay verbatim; the agent's additions
        // follow. Config is the author's word and outranks the model's.
        requirements = [...(config.requirements ?? []), ...parsed.requirements];
        criteria = withIds(parsed.acceptanceCriteria);
    }
    // Always written against the repository root: a spec is the run's contract,
    // not the property of whichever worktree happened to be current.
    const relativePath = specRelativePath(ctx.runId);
    const absolutePath = join(ctx.repoRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, renderSpec(ctx.runId, title, requirements, criteria));
    yield {
        type: 'result',
        output: { specPath: relativePath, title, requirements, acceptanceCriteria: criteria },
    };
    yield { type: 'status', status: 'done' };
};
//# sourceMappingURL=spec.js.map