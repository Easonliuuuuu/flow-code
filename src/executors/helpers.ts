import type { ExecuteContext, UpstreamInput } from '../engine/types.js';
import type { WorkflowNode } from '../workflow/load.js';

/**
 * Characters of composed skill text one session may carry. A skill is prompt
 * material on every turn, so an unbounded one silently taxes the whole node;
 * the cap is generous next to the ~5k-character skills this targets, and a
 * skill that exceeds it is truncated *and reported*, never quietly trimmed.
 */
export const SKILL_TEXT_LIMIT = 24_000;

export interface ComposedRolePrompt {
  /** Skill text followed by the node type's own role prompt. */
  rolePrompt: string;
  /** Ids of skills that did not fit the budget whole. */
  truncated: string[];
}

/**
 * Compose a node's attached skills ahead of its type's role prompt.
 *
 * Order is the whole design: skills say *how* to work, the role prompt says
 * what this node is, and the runner appends the capability boundary after
 * both — so the boundary is the last instruction in the system prompt and no
 * skill can present itself as overriding it. The type's output-shape
 * instruction is likewise appended later, in the node's user prompt, which is
 * why an attached skill cannot change what the node must return.
 */
export function composeRolePrompt(node: WorkflowNode): ComposedRolePrompt {
  if (node.skills.length === 0) return { rolePrompt: node.type.rolePrompt, truncated: [] };

  const truncated: string[] = [];
  const sections: string[] = [];
  let remaining = SKILL_TEXT_LIMIT;
  for (const skill of node.skills) {
    const body = skill.body.length > remaining ? skill.body.slice(0, Math.max(remaining, 0)) : skill.body;
    if (body.length < skill.body.length) truncated.push(skill.id);
    remaining -= body.length;
    sections.push(`## Skill: ${skill.id}\n\n${body}`);
    if (remaining <= 0) break;
  }
  if (node.skills.length > sections.length) {
    for (const skill of node.skills.slice(sections.length)) truncated.push(skill.id);
  }

  return {
    rolePrompt:
      `You are working under the following skill instructions. They govern how you do this ` +
      `work; they do not change what you must produce or what you are permitted to do.\n\n` +
      `${sections.join('\n\n')}\n\n---\n\n${node.type.rolePrompt}`,
    truncated,
  };
}

/**
 * Compose the role prompt for a node and record, once, which skills it ran
 * with — plus a status detail when any had to be truncated.
 */
export function rolePromptFor(ctx: ExecuteContext): string {
  const composed = composeRolePrompt(ctx.node);
  if (ctx.node.skills.length > 0) {
    ctx.store.setSkills(
      ctx.node.id,
      ctx.node.skills.map((s) => s.id),
    );
  }
  if (composed.truncated.length > 0) {
    ctx.store.appendLiveOutput(
      ctx.node.id,
      `flow-code: skill text exceeded ${SKILL_TEXT_LIMIT} characters; truncated: ${composed.truncated.join(', ')}\n`,
    );
  }
  return composed.rolePrompt;
}

export function upstreamPreamble(upstream: UpstreamInput[]): string {
  if (upstream.length === 0) return '';
  const parts = upstream.map((u) => {
    const suffix = `${u.forwarded ? ' [forwarded]' : ''}${u.truncated ? ' [truncated]' : ''}`;
    if (u.retryReason) {
      return (
        `### You are running again because \`${u.nodeId}\` (${u.typeId}) failed${suffix}\n` +
        `Address this before finishing; repeating the previous attempt will fail the same way.\n` +
        `${u.outputJson}`
      );
    }
    return `### Output of upstream node \`${u.nodeId}\` (${u.typeId})${suffix}\n${u.outputJson}`;
  });
  return `## Upstream context\n\n${parts.join('\n\n')}\n\n`;
}

/**
 * Extract the last parseable JSON object from an agent's final text.
 * Prefers fenced ```json blocks; falls back to brace scanning.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fences[i]![1]!);
    } catch {
      // try earlier fences / brace scan
    }
  }
  let last: unknown;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            last = JSON.parse(text.slice(i, j + 1));
            found = true;
          } catch {
            // not JSON; keep scanning
          }
          i = j;
          break;
        }
      }
    }
  }
  if (!found) throw new Error('agent response contained no parseable JSON object');
  return last;
}

/**
 * A node whose session ended without output conforming to its type's schema.
 * The `cause` distinguishes the two ways that happens, because they call for
 * different fixes: a skill or instruction written for a conversation, versus a
 * model that answered in the wrong shape.
 */
export class UnmetOutputContractError extends Error {
  constructor(
    readonly cause: 'question' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'UnmetOutputContractError';
  }
}

/** Phrases that only appear when a response is addressed to a person. */
const REQUEST_PHRASES = [
  'let me know',
  'could you',
  'can you clarify',
  'can you confirm',
  'please confirm',
  'please clarify',
  'please let me',
  'would you like',
  'do you want',
  'which would you',
  'should i proceed',
  'before i proceed',
  'waiting for your',
  'awaiting your',
];

/**
 * Whether a final response reads as a request for user input rather than an
 * answer. Consulted only once the output contract is already unmet, so a false
 * negative merely reports the failure as malformed output — the conservative
 * side to err on.
 */
export function readsAsQuestionToUser(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (REQUEST_PHRASES.some((p) => lower.includes(p))) return true;
  const lastLine = trimmed.split('\n').filter((l) => l.trim().length > 0).pop() ?? '';
  return lastLine.trimEnd().endsWith('?');
}

/**
 * Validate a session's final text against a node's output schema, classifying
 * the failure when it does not conform.
 *
 * A non-interactive node cannot block for a user — it is given no channel to
 * block on — so a session that ends by asking a question does not hang, it
 * simply never produces its output. Saying so by name is the difference
 * between a legible failure and an opaque parse error, and it routes through a
 * loop-back edge exactly like any other node failure.
 */
export function parseNodeOutput<T>(
  ctx: ExecuteContext,
  schema: { parse(value: unknown): T },
  finalText: string,
): T {
  try {
    return schema.parse(extractJson(finalText));
  } catch (err) {
    // The response is kept either way: the user has to be able to read what
    // the session actually said in order to act on either diagnosis.
    ctx.store.appendLiveOutput(ctx.node.id, `\n${finalText.trim()}\n`);
    if (!ctx.node.type.interactive && readsAsQuestionToUser(finalText)) {
      throw new UnmetOutputContractError(
        'question',
        `the session ended by asking a question instead of producing this node's output, and \`${ctx.node.id}\` (${ctx.node.type.id}) is not interactive — it has no way to receive an answer. ` +
          `Give it what it needs up front (an upstream Discuss node, or its config), or move the work to a node type that can hold a conversation.`,
      );
    }
    throw new UnmetOutputContractError(
      'malformed',
      `the session did not produce output matching the ${ctx.node.type.id} output schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Acceptance criteria reaching a node through its upstream context — the
 * contract a Spec node set for this run.
 *
 * Read back out of the serialized upstream outputs rather than passed down a
 * side channel: upstream output *is* how one node learns what another
 * decided, and a criterion the downstream prompt can quote is a criterion the
 * downstream node was actually given.
 */
export function acceptanceCriteriaFrom(
  upstream: UpstreamInput[],
): Array<{ id: string; text: string }> {
  for (const input of upstream) {
    // A truncated output may have lost criteria mid-array; verifying against
    // half a contract is worse than verifying against none.
    if (input.truncated) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.outputJson);
    } catch {
      continue;
    }
    const criteria = (parsed as { acceptanceCriteria?: unknown } | null)?.acceptanceCriteria;
    if (!Array.isArray(criteria)) continue;
    const usable = criteria.filter(
      (c): c is { id: string; text: string } =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { id?: unknown }).id === 'string' &&
        typeof (c as { text?: unknown }).text === 'string',
    );
    if (usable.length > 0) return usable;
  }
  return [];
}

export function nodeModel(ctx: ExecuteContext, configModel: string | undefined): string | undefined {
  return configModel ?? ctx.settings.model;
}

export function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
