import { capabilitySet } from '../capabilities.js';
import { captureTree, diffNamesBetweenTrees, diffTrees, headCommit } from '../git/ops.js';
import { reviewOutput, validateOutput, } from '../registry/index.js';
import { extractJson, nodeModel, truncateText, upstreamPreamble } from './helpers.js';
async function runNodeSession(ctx, prompt, model) {
    const release = await ctx.acquireSessionSlot();
    try {
        const { finalText } = await ctx.sessions.run({
            nodeId: ctx.node.id,
            capabilities: capabilitySet(...ctx.node.type.capabilities),
            rolePrompt: ctx.node.type.rolePrompt,
            prompt,
            workingDir: ctx.workingDir,
            ...(model !== undefined ? { model } : {}),
            onText: (t) => ctx.store.appendLiveOutput(ctx.node.id, t + '\n'),
            signal: ctx.signal,
        }, ctx.store);
        return finalText;
    }
    finally {
        release();
    }
}
export const executeImplement = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    const preTree = await captureTree(ctx.workingDir);
    const prompt = `${upstreamPreamble(ctx.upstream)}## Task\n\n${config.instructions}`;
    const finalText = await runNodeSession(ctx, prompt, nodeModel(ctx, config.model));
    const postTree = await captureTree(ctx.workingDir);
    const diff = await diffTrees(ctx.workingDir, preTree, postTree);
    const changedFiles = await diffNamesBetweenTrees(ctx.workingDir, preTree, postTree);
    yield {
        type: 'result',
        output: { changedFiles, diff, summary: truncateText(finalText, 2000) },
    };
    yield { type: 'status', status: 'done' };
};
export const executeValidate = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    const prompt = `${upstreamPreamble(ctx.upstream)}## Validation task\n\n` +
        `${config.instructions ?? 'Check whether the work described in the upstream context has actually been carried out in this working directory, and satisfies its intent.'}\n\n` +
        `When you are done, respond with ONLY a JSON object:\n` +
        `{"verdict": "pass" | "fail", "notes": "<what you checked and what you found>"}`;
    const finalText = await runNodeSession(ctx, prompt, nodeModel(ctx, config.model));
    const parsed = validateOutput.parse(extractJson(finalText));
    // No terminal status here: the type's `failsWhen` predicate decides whether
    // this verdict is a pass or a failure.
    yield { type: 'result', output: parsed };
};
export const executeReview = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    const prompt = `${upstreamPreamble(ctx.upstream)}## Review task\n\n` +
        `${config.instructions ?? 'Review the pending changes described in the upstream context for correctness, clarity, and risk.'}\n\n` +
        `When you are done, respond with ONLY a JSON object:\n` +
        `{"verdict": "pass" | "fail", "findings": [{"location": "<file:line or area>", "description": "<finding>", "severity": "info" | "minor" | "major"}]}`;
    const finalText = await runNodeSession(ctx, prompt, nodeModel(ctx, config.model));
    const parsed = reviewOutput.parse(extractJson(finalText));
    // No terminal status here: see executeValidate.
    yield { type: 'result', output: parsed };
};
export const executeGitOps = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    let preHead;
    try {
        preHead = await headCommit(ctx.workingDir);
    }
    catch {
        preHead = '';
    }
    const steps = [
        `Commit all pending changes in this working directory with the commit message: ${JSON.stringify(config.commitMessage ?? 'flow-code: apply workflow changes')}.`,
        'If there is nothing to commit, say so and stop.',
    ];
    if (config.push) {
        steps.push(`After committing, push the current branch to remote \`${config.push.remote}\`, branch \`${config.push.branch}\` (git push ${config.push.remote} HEAD:${config.push.branch}).`);
    }
    else {
        steps.push('Do NOT push to any remote.');
    }
    const prompt = `${upstreamPreamble(ctx.upstream)}## Git operations\n\n${steps.join('\n')}`;
    await runNodeSession(ctx, prompt, nodeModel(ctx, config.model));
    let postHead;
    try {
        postHead = await headCommit(ctx.workingDir);
    }
    catch {
        postHead = '';
    }
    const committed = postHead !== '' && postHead !== preHead;
    // The activity log is the source of truth for what actually ran.
    const pushed = config.push !== undefined &&
        ctx.store
            .activityFor(ctx.node.id)
            .some((e) => e.decision === 'allowed' &&
            /(^|[\s;&|])git\s+([^|;&]*\s)?push(\s|$)/.test(e.summary) &&
            (e.exitStatus === 0 || e.exitStatus === undefined || e.exitStatus === null) &&
            e.error === undefined);
    yield {
        type: 'result',
        output: {
            committed,
            ...(committed ? { commit: postHead } : {}),
            pushed,
            ...(config.push ? { remote: config.push.remote, branch: config.push.branch } : {}),
        },
    };
    yield { type: 'status', status: 'done' };
};
//# sourceMappingURL=agents.js.map