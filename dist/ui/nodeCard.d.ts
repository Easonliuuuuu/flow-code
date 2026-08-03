import type { ActivityEntry, NodeRunState } from '../runstate/types.js';
import type { WorkflowNode } from '../workflow/load.js';
export declare function spinnerFrame(frame: number): string;
/**
 * Trailing ellipsis that grows 0→3 dots and back to 0, padded to a constant
 * width so the text in front of it never shifts between frames.
 */
export declare function ellipsis(frame: number): string;
/** `842`, `12.4k`, `1.2M` — short enough to sit inside a node box. */
export declare function formatTokens(n: number): string;
/** `4s`, `1m04s`, `2h07m` — fixed-ish width so a ticking clock doesn't jitter. */
export declare function formatDuration(ms: number): string;
/**
 * What this node *will* do, drawn while it hasn't run yet: the interesting
 * part of its config, not its type name repeated back. A node type with
 * nothing configurable falls back to a one-line description of its job, so
 * the row is never empty.
 */
export declare function plannedSummary(node: WorkflowNode): string;
/**
 * What this node actually produced, drawn once it's finished: the headline of
 * its output, so a completed graph reads as a report rather than a row of
 * green dots.
 */
export declare function outcomeSummary(node: WorkflowNode, output: unknown): string | null;
/**
 * The line under a node's title: what it's doing right now while it runs,
 * what it produced once it's done, and what it's going to do before that.
 * Running nodes prefer their most recent tool call — that's the closest thing
 * the UI has to watching over the agent's shoulder.
 */
export declare function nodeSubtitle(node: WorkflowNode, state: NodeRunState, activity: ActivityEntry[], frame: number, 
/** Characters the card can actually show — the box is sized by the layout,
 * so eliding to a hardcoded guess either wasted space or cut text the box
 * had room for. */
width?: number): string;
/**
 * The metrics line: tokens consumed so far and wall-clock time, both live
 * while the node runs and frozen at its final value afterwards. Empty for a
 * node that hasn't started — there is nothing to measure yet.
 */
export declare function nodeMetrics(state: NodeRunState, now: number, 
/** Drop the clock and keep only the token counts — the compact card puts
 * this on the title row, where there is rarely room for both, and tokens
 * are the number a budget is spent in. */
options?: {
    clock?: boolean;
}): string;
/** Every token the run has consumed, for the header total. */
export declare function totalTokens(nodes: Record<string, NodeRunState>): number;
