import { capabilitySet } from '../capabilities.js';
import { discussOutput } from '../registry/index.js';
import { extractJson, nodeModel, upstreamPreamble } from './helpers.js';
/**
 * Interactive sub-panel flow: the node holds at `waiting` until the user
 * explicitly signals completion (the port resolves null). The engine starts
 * no other node while a Discuss node is active.
 */
export const executeDiscuss = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    // A prior transcript/session id means `--resume` reset this node from a
    // conversation ctrl+c cut short — continue it instead of starting blank.
    const prior = ctx.store.node(ctx.node.id);
    const resuming = (prior.discussTranscript?.length ?? 0) > 0 && prior.sessionId !== undefined;
    const release = await ctx.acquireSessionSlot();
    try {
        const session = await ctx.sessions.openInteractive({
            nodeId: ctx.node.id,
            capabilities: capabilitySet(...ctx.node.type.capabilities),
            rolePrompt: ctx.node.type.rolePrompt,
            prompt: '',
            workingDir: ctx.workingDir,
            ...(nodeModel(ctx, config.model) !== undefined
                ? { model: nodeModel(ctx, config.model) }
                : {}),
            onText: (t) => ctx.store.appendLiveOutput(ctx.node.id, t + '\n'),
            signal: ctx.signal,
            onSessionId: (id) => ctx.store.setSessionId(ctx.node.id, id),
            ...(resuming ? { resumeSessionId: prior.sessionId } : {}),
        }, ctx.store);
        const postAssistant = (text) => {
            ctx.ports.discuss.postAssistant(ctx.node.id, text);
            ctx.store.appendDiscussMessage(ctx.node.id, { role: 'assistant', text });
        };
        ctx.ports.discuss.begin(ctx.node.id, config.topic, prior.discussTranscript);
        yield { type: 'status', status: 'waiting', detail: 'in discussion' };
        if (!resuming) {
            const opening = `${upstreamPreamble(ctx.upstream)}Open a discussion with the user` +
                (config.topic ? ` about: ${config.topic}` : ' about what this change should accomplish.') +
                ' Ask what they want to achieve and surface any constraints worth pinning down. Keep it brief.';
            postAssistant(await session.send(opening));
        }
        for (;;) {
            const userText = await ctx.ports.discuss.nextUserMessage(ctx.node.id);
            if (userText === null)
                break;
            ctx.store.appendDiscussMessage(ctx.node.id, { role: 'user', text: userText });
            postAssistant(await session.send(userText));
        }
        const conclusionText = await session.send('The user has ended the discussion. Respond with ONLY a JSON object recording what was agreed, ' +
            'in a form a downstream implementation step can consume without the transcript:\n' +
            '{"conclusion": "<what should be done>", "constraints": ["<agreed constraint>", …]}');
        await session.end();
        ctx.ports.discuss.end(ctx.node.id);
        const parsed = discussOutput.parse(extractJson(conclusionText));
        yield { type: 'result', output: parsed };
        yield { type: 'status', status: 'done' };
    }
    finally {
        release();
    }
};
//# sourceMappingURL=discuss.js.map