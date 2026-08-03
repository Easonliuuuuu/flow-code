import type { ExecuteContext, UpstreamInput } from '../engine/types.js';
import type { WorkflowNode } from '../workflow/load.js';
/**
 * Characters of composed skill text one session may carry. A skill is prompt
 * material on every turn, so an unbounded one silently taxes the whole node;
 * the cap is generous next to the ~5k-character skills this targets, and a
 * skill that exceeds it is truncated *and reported*, never quietly trimmed.
 */
export declare const SKILL_TEXT_LIMIT = 24000;
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
export declare function composeRolePrompt(node: WorkflowNode): ComposedRolePrompt;
/**
 * Compose the role prompt for a node and record, once, which skills it ran
 * with — plus a status detail when any had to be truncated.
 */
export declare function rolePromptFor(ctx: ExecuteContext): string;
export declare function upstreamPreamble(upstream: UpstreamInput[]): string;
/**
 * Extract the last parseable JSON object from an agent's final text.
 * Prefers fenced ```json blocks; falls back to brace scanning.
 */
export declare function extractJson(text: string): unknown;
/**
 * A node whose session ended without output conforming to its type's schema.
 * The `cause` distinguishes the two ways that happens, because they call for
 * different fixes: a skill or instruction written for a conversation, versus a
 * model that answered in the wrong shape.
 */
export declare class UnmetOutputContractError extends Error {
    readonly cause: 'question' | 'malformed';
    constructor(cause: 'question' | 'malformed', message: string);
}
/**
 * Whether a final response reads as a request for user input rather than an
 * answer. Consulted only once the output contract is already unmet, so a false
 * negative merely reports the failure as malformed output — the conservative
 * side to err on.
 */
export declare function readsAsQuestionToUser(text: string): boolean;
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
export declare function parseNodeOutput<T>(ctx: ExecuteContext, schema: {
    parse(value: unknown): T;
}, finalText: string): T;
/**
 * Acceptance criteria reaching a node through its upstream context — the
 * contract a Spec node set for this run.
 *
 * Read back out of the serialized upstream outputs rather than passed down a
 * side channel: upstream output *is* how one node learns what another
 * decided, and a criterion the downstream prompt can quote is a criterion the
 * downstream node was actually given.
 */
export declare function acceptanceCriteriaFrom(upstream: UpstreamInput[]): Array<{
    id: string;
    text: string;
}>;
export declare function nodeModel(ctx: ExecuteContext, configModel: string | undefined): string | undefined;
export declare function truncateText(text: string, limit: number): string;
