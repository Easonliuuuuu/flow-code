import type { NodeStatus, RunState } from '../runstate/types.js';
import type { Workflow } from '../workflow/load.js';
import type { Layout, Viewport } from './layout.js';
export interface Cell {
    ch: string;
    style: string;
}
export type Grid = Cell[][];
export declare const STATUS_GLYPHS: Record<NodeStatus, string>;
/**
 * The model a node's box should badge, or null when it's running on the
 * run-wide default. `workflow.settings.model` already carries the provider
 * fallback baked in by the time the UI sees it (see `cmdRun` in `cli.ts`),
 * so it alone is "the effective default a node without its own override
 * would get" — no separate provider-default plumbing needed here, only in
 * the detail view's origin/provenance line, which the App computes itself.
 */
export declare function nodeModelBadge(workflow: Workflow, nodeId: string): string | null;
export declare function makeGrid(width: number, height: number): Grid;
/**
 * Animation inputs, passed in rather than read from the clock so a render is
 * a pure function of its arguments (and so tests get stable frames).
 */
export interface AnimationState {
    /** Monotonic tick; advances while any node is running. */
    frame: number;
    /** `Date.now()` at render time, for live elapsed-time counters. */
    now: number;
}
/** Render the workflow graph (boxes + elbow edges) onto a character grid. */
export declare function renderGraph(workflow: Workflow, layout: Layout, runState: RunState, focusedId: string | null, anim?: AnimationState): Grid;
/** Slice the grid through a viewport and emit ANSI-styled lines. */
export declare function gridToLines(grid: Grid, viewport: Viewport): string[];
