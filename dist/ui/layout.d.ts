import type { Workflow } from '../workflow/load.js';
/** Border, title, type/model, live subtitle, metrics, border — see renderGraph. */
export declare const BOX_HEIGHT = 6;
/** Border, title (with metrics inline), border — the compact card. */
export declare const COMPACT_BOX_HEIGHT = 3;
export declare const GAP_X = 5;
export declare const GAP_Y = 1;
/**
 * Boxes are sized for their content rows, not just their title: the subtitle
 * and metrics lines carry real text, and a box narrow enough to fit only an
 * id would truncate all of it away.
 */
export declare const MIN_BOX_CONTENT = 22;
/**
 * Past this, a card stops being a card. A summary longer than this is elided
 * on the box and read in full in the detail panel; the alternative is one
 * verbose node stretching its whole layer and pushing everything downstream
 * off the screen.
 */
export declare const MAX_BOX_CONTENT = 46;
export interface NodeBox {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    layer: number;
}
export interface Layout {
    boxes: Map<string, NodeBox>;
    width: number;
    height: number;
}
/** Session-only position overrides from mouse dragging; never persisted. */
export type PositionOverrides = Map<string, {
    dx: number;
    dy: number;
}>;
export interface LayoutOptions {
    /**
     * Collapse every card to title-only. Uniform rather than per-node so the
     * graph doesn't reflow as focus moves; the full detail of one node is a
     * keypress away in the detail panel.
     */
    compact?: boolean;
}
/**
 * Left-to-right auto-layout in dependency order: a node's layer is the
 * longest path from any root, so every node is drawn after all of its
 * dependencies.
 */
export declare function computeLayout(workflow: Workflow, overrides?: PositionOverrides, options?: LayoutOptions): Layout;
export interface Viewport {
    ox: number;
    oy: number;
    width: number;
    height: number;
}
/** Adjust viewport offsets so `box` is fully visible (focus scrolls into view). */
export declare function scrollIntoView(box: NodeBox, viewport: Viewport): {
    ox: number;
    oy: number;
};
/**
 * Hold the viewport over the graph. Panning is otherwise unbounded in the
 * positive direction, and a canvas panned into empty space gives no clue
 * which way the graph went — the offsets stop one screen short of the far
 * edge so there is always something drawn.
 */
export declare function clampOffset(layout: Layout, viewport: {
    ox: number;
    oy: number;
    width: number;
    height: number;
}): {
    ox: number;
    oy: number;
};
/** Boxes lying outside the viewport, per direction — for the header's hints. */
export interface OffscreenCounts {
    left: number;
    right: number;
    up: number;
    down: number;
}
/**
 * How many nodes sit off each edge of the viewport. Counted per box rather
 * than derived from the layout bounds so the hint says "3 more that way"
 * instead of merely "there is more canvas".
 */
export declare function offscreenCounts(layout: Layout, viewport: {
    ox: number;
    oy: number;
    width: number;
    height: number;
}): OffscreenCounts;
export declare function hitTest(layout: Layout, x: number, y: number): string | null;
