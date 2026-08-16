import { capabilitySet } from '../capabilities.js';
import type { Capability } from '../capabilities.js';
import type { NodeExecutor } from '../engine/types.js';
import { nodeTypeReferenceLines, planOutput, type PlanConfig } from '../registry/index.js';
import { defaultSkillRoots } from '../skills/discover.js';
import { buildWorkflowFromRaw, WorkflowValidationError } from '../workflow/load.js';
import { spliceProposal, type PlanProposal } from '../workflow/splice.js';
import { nodeModel, rolePromptFor, upstreamPreamble } from './helpers.js';

/**
 * A reply ends with a fenced block carrying the proposed graph as JSON,
 * mirroring how Discuss's tappable options are split out of the prose —
 * see that file's `OPTIONS_BLOCK` for the same pattern:
 *
 *   <<<PLAN
 *   {"nodes": [...], "edges": [...]}
 *   >>>
 */
const PLAN_BLOCK = /\n?<<<PLAN\n([\s\S]*?)\n>>>[ \t]*/g;

function parsePlanBlock(body: string): PlanProposal | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { nodes?: unknown }).nodes) &&
      ((parsed as { edges?: unknown }).edges === undefined ||
        Array.isArray((parsed as { edges?: unknown }).edges))
    ) {
      const p = parsed as { nodes: PlanProposal['nodes']; edges?: PlanProposal['edges'] };
      return { nodes: p.nodes, edges: p.edges ?? [] };
    }
    return null;
  } catch {
    return null;
  }
}

function splitProposal(text: string): { prose: string; proposal: PlanProposal | null } {
  const matches = [...text.trimEnd().matchAll(PLAN_BLOCK)];
  if (matches.length === 0) return { prose: text, proposal: null };
  // Mirrors Discuss: a malformed block is shown as written rather than
  // silently dropped, and the first well-formed one is the one that counts.
  const proposal = matches.map((m) => parsePlanBlock(m[1]!)).find((p) => p !== null) ?? null;
  if (proposal === null) return { prose: text, proposal: null };
  const prose = text.trimEnd().replace(PLAN_BLOCK, '').trimEnd();
  return { prose, proposal };
}

const PLAN_PROTOCOL =
  ' When you are ready to propose a graph — and whenever you revise one — end your reply with a' +
  ' line reading exactly "<<<PLAN", then a JSON object of the exact shape' +
  ' {"nodes": [{"id": "...", "type": "...", "config": {...}}, ...], "edges": [{"from": "...", "to": "..."}, ...]},' +
  ' then a line reading exactly ">>>", and nothing after it. Use only the node types listed' +
  " below; every node id must be unique within your proposal. The graph is not adopted until" +
  ' the user explicitly accepts it — revise it as many times as the conversation calls for.' +
  ' Do not include a `plan` node in your proposal: there is exactly one, and it is this one.';

const IMPLEMENT_TEST_NOTE =
  '\n\nOne thing worth knowing when you size the graph: an Implement node holds `exec` and will' +
  ' typically run tests itself while it works, so a following Test node is reconfirming a claim,' +
  " not running tests for the first time. That is not waste — Test's verdict is a deterministic" +
  " exit code, never a model's opinion, and it is what a loop-back edge routes on and what" +
  ' Validate and the approval gate read. For a fast suite, have Test run it in full; for a slow' +
  " one, scope Implement's instructions to the changed area and let Test run the full suite once.";

function nodeVocabulary(): string {
  return `\n\nAvailable node types:\n\n${nodeTypeReferenceLines().join('\n')}`;
}

/**
 * The Plan node: like Discuss, an interactive session that holds at
 * `waiting` until the user acts — but a turn here is "keep talking" or
 * "accept the graph on the table," not "keep talking" or "stop," and only
 * the latter can complete the node. A proposal the user accepts is validated
 * through the same checks a hand-written workflow file passes before it is
 * treated as accepted; a proposal that fails is never adopted — the failures
 * go back into the same session as the next turn.
 */
export const executePlan: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  const config = ctx.node.config as PlanConfig;

  const prior = ctx.store.node(ctx.node.id);
  const resuming = (prior.discussTranscript?.length ?? 0) > 0 && prior.sessionId !== undefined;

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

    // Not persisted across a resume — an interrupted session's last proposal
    // is recoverable in one extra turn (the agent re-states it from its own
    // resumed history), which is simpler than a run-state field dedicated to
    // holding a not-yet-accepted draft.
    let currentProposal: PlanProposal | null = null;

    const postAssistant = (text: string): void => {
      const { prose, proposal } = splitProposal(text);
      if (proposal) currentProposal = proposal;
      ctx.ports.plan.postAssistant(ctx.node.id, prose, proposal);
      ctx.store.appendDiscussMessage(ctx.node.id, { role: 'assistant', text: prose });
    };

    ctx.ports.plan.begin(ctx.node.id, config.topic, prior.discussTranscript);
    yield { type: 'status', status: 'waiting', detail: 'planning' };

    if (!resuming) {
      const opening =
        `${upstreamPreamble(ctx.upstream)}Open a discussion with the user` +
        (config.topic ? ` about: ${config.topic}` : ' about what this run should build.') +
        ' Settle what is being built, then propose a graph shaped for it.' +
        PLAN_PROTOCOL +
        nodeVocabulary() +
        IMPLEMENT_TEST_NOTE;
      postAssistant(await session.send(opening));
    }

    for (;;) {
      const turn = await ctx.ports.plan.nextTurn(ctx.node.id);

      if (turn === null) {
        await session.end();
        ctx.ports.plan.end(ctx.node.id);
        yield {
          type: 'status',
          status: 'error',
          detail: 'the session ended without the user accepting a graph',
        };
        return;
      }

      if ('text' in turn) {
        ctx.store.appendDiscussMessage(ctx.node.id, { role: 'user', text: turn.text });
        postAssistant(await session.send(turn.text));
        continue;
      }

      // turn is { accept: true }
      if (!currentProposal) {
        postAssistant(
          await session.send(
            'The user tried to accept, but no proposal is on the table yet. Propose a graph now.',
          ),
        );
        continue;
      }

      try {
        buildWorkflowFromRaw(spliceProposal(ctx.workflow, ctx.node.id, currentProposal), {
          repoRoot: ctx.repoRoot,
          skillRoots: defaultSkillRoots(ctx.repoRoot),
        });
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        const feedback =
          'That proposal is invalid and cannot be accepted:\n' +
          err.problems.map((p) => `- ${p}`).join('\n') +
          '\nPropose a corrected graph.';
        postAssistant(await session.send(feedback));
        continue;
      }

      await session.end();
      ctx.ports.plan.end(ctx.node.id);
      // Already validated above as part of the merged graph, which uses the
      // same node/edge schemas this parses against — expected to be a no-op.
      const output = planOutput.parse(currentProposal);
      yield { type: 'result', output };
      yield { type: 'status', status: 'done' };
      return;
    }
  } finally {
    release();
  }
};
