import type { ExecuteContext, UpstreamInput } from '../engine/types.js';
export declare function upstreamPreamble(upstream: UpstreamInput[]): string;
/**
 * Extract the last parseable JSON object from an agent's final text.
 * Prefers fenced ```json blocks; falls back to brace scanning.
 */
export declare function extractJson(text: string): unknown;
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
