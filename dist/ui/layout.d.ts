import type { Workflow } from '../workflow/load.js';
export declare const BOX_HEIGHT = 4;
export declare const GAP_X = 7;
export declare const GAP_Y = 1;
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
/**
 * Left-to-right auto-layout in dependency order: a node's layer is the
 * longest path from any root, so every node is drawn after all of its
 * dependencies.
 */
export declare function computeLayout(workflow: Workflow, overrides?: PositionOverrides): Layout;
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
export declare function hitTest(layout: Layout, x: number, y: number): string | null;
