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

export const MIN_PANEL_WIDTH = 24;
export const MIN_PANEL_HEIGHT = 8;

/** The default docked rect: full width, pinned to the bottom, `height` rows tall. */
export function dockedRect(bounds: Bounds, height: number): PanelRect {
  const h = Math.min(height, bounds.rows);
  return { x: 0, y: Math.max(0, bounds.rows - h), w: bounds.columns, h };
}

/** Fraction of the terminal a docked panel takes up by default. */
export const DOCKED_HEIGHT_RATIO = 0.6;

/**
 * Splits the terminal between the canvas and a docked panel, below `headerRows`
 * of header. The panel is bottom-anchored, so the canvas must take up exactly
 * the rows between the header and the panel's top edge — any slack there shifts
 * the panel away from this rect and breaks border hit-testing.
 */
export function dockedLayout(
  bounds: Bounds,
  headerRows: number,
): { rect: PanelRect; canvasHeight: number } {
  // Always leave at least one canvas row, however short the terminal is.
  const maxHeight = Math.max(1, bounds.rows - headerRows - 1);
  const height = Math.min(
    Math.max(MIN_PANEL_HEIGHT, Math.floor(bounds.rows * DOCKED_HEIGHT_RATIO)),
    maxHeight,
  );
  const rect = dockedRect(bounds, height);
  return { rect, canvasHeight: rect.y - headerRows };
}

export type PanelHitZone = 'move' | 'resize' | null;

/** The grip glyph drawn in the panel's bottom-right corner, marking the {@link RESIZE_GRIP_W}×{@link RESIZE_GRIP_H} grab zone. */
export const RESIZE_GRIP = '⇲';
/** The handle glyph drawn at the left of the title row, marking it draggable. */
export const MOVE_HANDLE = '⠿';
/**
 * Size of the bottom-right grab zone. A single corner cell is far too small a
 * mouse target, so the zone covers the border corner plus the last content
 * cell inside it — which is exactly where the grip glyph is drawn.
 */
export const RESIZE_GRIP_W = 3;
export const RESIZE_GRIP_H = 2;

/**
 * Which part of the panel a press at (x, y) landed on, if any.
 * The bottom-right grip resizes; any border edge — plus the title row just
 * inside the top border, which acts as a title bar — moves. The rest of the
 * interior (and anywhere outside the rect) is not draggable, so panel
 * content — text, scroll clicks — isn't hijacked into a drag.
 */
export function hitTestPanel(rect: PanelRect, x: number, y: number): PanelHitZone {
  if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) return null;
  if (x >= rect.x + rect.w - RESIZE_GRIP_W && y >= rect.y + rect.h - RESIZE_GRIP_H) return 'resize';
  const onLeft = x === rect.x;
  const onRight = x === rect.x + rect.w - 1;
  const onTop = y === rect.y;
  const onBottom = y === rect.y + rect.h - 1;
  const onTitleBar = y === rect.y + 1;
  if (onTop || onBottom || onLeft || onRight || onTitleBar) return 'move';
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Moves `origin` by (dx, dy), clamped so the panel stays fully on screen. */
export function applyPanelMove(origin: PanelRect, dx: number, dy: number, bounds: Bounds): PanelRect {
  const x = clamp(origin.x + dx, 0, Math.max(0, bounds.columns - origin.w));
  const y = clamp(origin.y + dy, 0, Math.max(0, bounds.rows - origin.h));
  return { ...origin, x, y };
}

/** Resizes `origin` from its bottom-right corner by (dx, dy), clamped to a minimum size and the screen. */
export function applyPanelResize(origin: PanelRect, dx: number, dy: number, bounds: Bounds): PanelRect {
  const w = clamp(origin.w + dx, MIN_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, bounds.columns - origin.x));
  const h = clamp(origin.h + dy, MIN_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, bounds.rows - origin.y));
  return { ...origin, w, h };
}

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
export function tailWindow(total: number, visible: number, pin: number | null): TailWindow {
  const v = Math.max(1, visible);
  const maxScroll = Math.max(0, total - v);
  if (pin === null) {
    return { start: maxScroll, end: maxScroll + v, maxScroll, following: true };
  }
  const start = Math.min(Math.max(0, pin), maxScroll);
  return { start, end: start + v, maxScroll, following: start >= maxScroll };
}

/**
 * Applies a scroll-by-rows gesture (PageUp/PageDown/wheel) to the current
 * window, returning the pin to store in state. `deltaRows` is positive to
 * scroll up (into history), negative to scroll down (toward live); snaps
 * back to `null` (resume following) once scrolled back down to the bottom.
 */
export function pinAfterScroll(win: TailWindow, deltaRows: number): number | null {
  const nextStart = win.start - deltaRows;
  if (nextStart >= win.maxScroll) return null;
  return Math.max(0, nextStart);
}
