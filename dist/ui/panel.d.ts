/**
 * Geometry and scroll math for the bottom status panel (Discuss / Convergence /
 * Approval / node-detail). Kept pure and separate from App.tsx so it's testable
 * without mounting Ink.
 *
 * The panel starts "docked": full width, pinned to the bottom, height a
 * fraction of the terminal. The first time it's dragged or resized it becomes
 * "floating" — an explicit `PanelRect` the caller stores in state — and stays
 * that way (including across future dock-height recalculations) until reset.
 */
export interface PanelRect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface Bounds {
    columns: number;
    rows: number;
}
export declare const MIN_PANEL_WIDTH = 24;
export declare const MIN_PANEL_HEIGHT = 8;
/** The default docked rect: full width, pinned to the bottom, `height` rows tall. */
export declare function dockedRect(bounds: Bounds, height: number): PanelRect;
/** Fraction of the terminal a docked panel takes up by default. */
export declare const DOCKED_HEIGHT_RATIO = 0.45;
/**
 * Splits the terminal between the canvas and a docked panel, below `headerRows`
 * of header. The panel is bottom-anchored, so the canvas must take up exactly
 * the rows between the header and the panel's top edge — any slack there shifts
 * the panel away from this rect and breaks border hit-testing.
 */
export declare function dockedLayout(bounds: Bounds, headerRows: number): {
    rect: PanelRect;
    canvasHeight: number;
};
export type PanelHitZone = 'move' | 'resize' | null;
/** The grip glyph drawn in the panel's bottom-right corner, marking the {@link RESIZE_GRIP_W}×{@link RESIZE_GRIP_H} grab zone. */
export declare const RESIZE_GRIP = "\u21F2";
/** The handle glyph drawn at the left of the title row, marking it draggable. */
export declare const MOVE_HANDLE = "\u283F";
/**
 * Size of the bottom-right grab zone. A single corner cell is far too small a
 * mouse target, so the zone covers the border corner plus the last content
 * cell inside it — which is exactly where the grip glyph is drawn.
 */
export declare const RESIZE_GRIP_W = 3;
export declare const RESIZE_GRIP_H = 2;
/**
 * Which part of the panel a press at (x, y) landed on, if any.
 * The bottom-right grip resizes; any border edge — plus the title row just
 * inside the top border, which acts as a title bar — moves. The rest of the
 * interior (and anywhere outside the rect) is not draggable, so panel
 * content — text, scroll clicks — isn't hijacked into a drag.
 */
export declare function hitTestPanel(rect: PanelRect, x: number, y: number): PanelHitZone;
/** Moves `origin` by (dx, dy), clamped so the panel stays fully on screen. */
export declare function applyPanelMove(origin: PanelRect, dx: number, dy: number, bounds: Bounds): PanelRect;
/** Resizes `origin` from its bottom-right corner by (dx, dy), clamped to a minimum size and the screen. */
export declare function applyPanelResize(origin: PanelRect, dx: number, dy: number, bounds: Bounds): PanelRect;
export interface TailWindow {
    start: number;
    end: number;
    maxScroll: number;
    /** True when showing the live tail — false once pinned to a historical row. */
    following: boolean;
}
/**
 * Slice window for a bottom-anchored, auto-following log (like a chat
 * transcript). `pin` is either `null` — follow the live tail, always
 * showing the newest `visible` rows as `total` grows — or an absolute row
 * index to hold the window's top edge at. Unlike a bottom-relative offset,
 * an absolute pin stays fixed as new rows are appended below it, so
 * reading history isn't disturbed by messages arriving.
 */
export declare function tailWindow(total: number, visible: number, pin: number | null): TailWindow;
/**
 * Applies a scroll-by-rows gesture (PageUp/PageDown/wheel) to the current
 * window, returning the pin to store in state. `deltaRows` is positive to
 * scroll up (into history), negative to scroll down (toward live); snaps
 * back to `null` (resume following) once scrolled back down to the bottom.
 */
export declare function pinAfterScroll(win: TailWindow, deltaRows: number): number | null;
