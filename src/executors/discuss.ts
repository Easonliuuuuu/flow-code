import { capabilitySet } from '../capabilities.js';
import type { Capability } from '../capabilities.js';
import type { NodeExecutor } from '../engine/types.js';
import { discussOutput, type DiscussConfig } from '../registry/index.js';
import { nodeModel, parseNodeOutput, rolePromptFor, upstreamPreamble } from './helpers.js';

/**
 * An assistant reply may end with a fenced block offering the user tappable
 * choices instead of forcing free text:
 *
 *   <<<OPTIONS
 *   ["Keep the existing auth", "Migrate to OAuth"]
 *   >>>
 *
 * Split it out of the prose so the transcript shows only what the agent
 * said, with the choices rendered separately by the UI.
 */
function splitOptions(text: string): { prose: string; options: string[] | null } {
  const trimmed = text.trimEnd();
  const match = /\n?<<<OPTIONS\n([\s\S]*?)\n>>>$/.exec(trimmed);
  if (!match) return { prose: text, options: null };
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((o) => typeof o === 'string')) {
      return { prose: trimmed.slice(0, match.index).trimEnd(), options: parsed as string[] };
    }
  } catch {
    // Malformed block — fall through and show it as plain prose rather than
    // silently dropping what the agent said.
  }
  return { prose: text, options: null };
}

/**
 * Interactive sub-panel flow: the node holds at `waiting` until the user
 * explicitly signals completion (the port resolves null). The engine starts
 * no other node while a Discuss node is active.
 */
export const executeDiscuss: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  const config = ctx.node.config as DiscussConfig;

  // A prior transcript/session id means this node was reset with a conversation
  // already on it — continue that instead of starting blank.
  const prior = ctx.store.node(ctx.node.id);
  const resuming = (prior.discussTranscript?.length ?? 0) > 0 && prior.sessionId !== undefined;
  // ...but *why* it was reset decides what the agent is told. `--resume` after a
  // ctrl+c leaves no retry reason: the conversation simply picks up. A loop-back
  // does, and resuming silently on that would hand the agent a conversation from
  // before the work it is being asked to reconsider — on a second loop-back,
  // from two attempts ago.
  const retrying = ctx.upstream.some((u) => u.retryReason);

  const release = await ctx.acquireSessionSlot();
  try {
    const session = await ctx.sessions.openInteractive(
      {
        nodeId: ctx.node.id,
        capabilities: capabilitySet(...(ctx.node.type.capabilities as Capability[])),
        rolePrompt: rolePromptFor(ctx),
        prompt: '',
        workingDir: ctx.workingDir,
        ...(nodeModel(ctx, config.model) !== undefined
          ? { model: nodeModel(ctx, config.model)! }
          : {}),
        onText: (t) => ctx.store.appendLiveOutput(ctx.node.id, t + '\n'),
        signal: ctx.signal,
        subagents: ctx.settings.subagents,
        subagentPool: ctx.subagentPool,
        onSessionId: (id) => ctx.store.setSessionId(ctx.node.id, id),
        ...(resuming ? { resumeSessionId: prior.sessionId! } : {}),
      },
      ctx.store,
    );

    const postAssistant = (text: string): void => {
      const { prose, options } = splitOptions(text);
      ctx.ports.discuss.postAssistant(ctx.node.id, prose, options);
      ctx.store.appendDiscussMessage(ctx.node.id, { role: 'assistant', text: prose });
    };

    ctx.ports.discuss.begin(ctx.node.id, config.topic, prior.discussTranscript);
    yield { type: 'status', status: 'waiting', detail: 'in discussion' };

    const OPTIONS_PROTOCOL =
      ' When a question boils down to a short list of natural choices, offer them as tappable' +
      ' options: end that reply with a line reading exactly "<<<OPTIONS", then a JSON array of' +
      ' 2-5 short option strings, then a line reading exactly ">>>", and nothing after it. Use this' +
      ' only for genuine multiple-choice moments — open-ended questions should stay plain text.';

    if (!resuming) {
      const opening =
        `${upstreamPreamble(ctx.upstream)}Open a discussion with the user` +
        (config.topic ? ` about: ${config.topic}` : ' about what this change should accomplish.') +
        ' Ask what they want to achieve and surface any constraints worth pinning down. Keep it brief.' +
        OPTIONS_PROTOCOL;
      postAssistant(await session.send(opening));
    } else if (retrying) {
      // Continue the same conversation, but say what happened since it stopped.
      // Without this the agent resumes mid-thread with no idea the work was
      // reconsidered, and the retry reason the engine recorded is never spoken.
      const reopening =
        `${upstreamPreamble(ctx.upstream)}You are picking this discussion back up because the ` +
        'work that followed it was sent back. Take the context above into account, tell the user ' +
        'briefly what you now understand needs to change, and settle what to do differently.' +
        OPTIONS_PROTOCOL;
      postAssistant(await session.send(reopening));
    }

    for (;;) {
      const userText = await ctx.ports.discuss.nextUserMessage(ctx.node.id);
      if (userText === null) break;
      ctx.store.appendDiscussMessage(ctx.node.id, { role: 'user', text: userText });
      postAssistant(await session.send(userText));
    }

    const conclusionText = await session.send(
      'The user has ended the discussion. Respond with ONLY a JSON object recording what was agreed, ' +
        'in a form a downstream implementation step can consume without the transcript:\n' +
        '{"conclusion": "<what should be done>", "constraints": ["<agreed constraint>", …]}',
    );
    await session.end();
    ctx.ports.discuss.end(ctx.node.id);

    const parsed = parseNodeOutput(ctx, discussOutput, conclusionText);
    yield { type: 'result', output: parsed };
    yield { type: 'status', status: 'done' };
  } finally {
    release();
  }
};
