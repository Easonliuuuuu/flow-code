import type { ExecuteContext, UpstreamInput } from '../engine/types.js';
export declare function upstreamPreamble(upstream: UpstreamInput[]): string;
/**
 * Extract the last parseable JSON object from an agent's final text.
 * Prefers fenced ```json blocks; falls back to brace scanning.
 */
export declare function extractJson(text: string): unknown;
export declare function nodeModel(ctx: ExecuteContext, configModel: string | undefined): string | undefined;
export declare function truncateText(text: string, limit: number): string;
