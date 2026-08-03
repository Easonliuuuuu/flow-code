import type { Workflow } from '../workflow/load.js';
import { plannedSummary } from './nodeCard.js';

/** Border, title, type/model, live subtitle, metrics, border — see renderGraph. */
export const BOX_HEIGHT = 6;
/** Border, title (with metrics inline), border — the compact card. */
export const COMPACT_BOX_HEIGHT = 3;
/** A single borderless row: status glyph + id — the overview-mode card. */
export const MINI_BOX_HEIGHT = 1;
export const GAP_X = 5;
export const GAP_Y = 1;

/** Mini-card width bounds — much narrower than a full/compact card's, since it holds no subtitle or metrics. */
export const MINI_MIN_BOX_CONTENT = 6;
export const MINI_MAX_BOX_CONTENT = 16;

/**
 * Where a hard-centered focused box lands in Focus mode: left-of-center
 * horizontally, so more of the downstream (rightward) graph stays visible —
 * the way editors keep the cursor left-of-center rather than dead-center —
 * and a couple of rows down from the top.
 */
export const FOCUS_ANCHOR_X_FRACTION = 0.3;
export const FOCUS_ANCHOR_Y_ROWS = 2;

/**
 * Boxes are sized for their content rows, not just their title: the subtitle
 * and metrics lines carry real text, and a box narrow enough to fit only an
 * id would truncate all of it away.
 */
export const MIN_BOX_CONTENT = 22;

/**
 * Past this, a card stops being a card. A summary longer than this is elided
 * on the box and read in full in the detail panel; the alternative is one
 * verbose node stretching its whole layer and pushing everything downstream
 * off the screen.
 */
export const MAX_BOX_CONTENT = 46;

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
export type PositionOverrides = Map<string, { dx: number; dy: number }>;

/**
 * Wide enough for the text the card actually wants to show. The subtitle is
 * measured from `plannedSummary`, which is a pure function of the node's
 * config: a width derived from the *live* subtitle instead would resize
 * boxes — and so reflow the whole graph — every time a running agent
 * reported a different tool call.
 */
function boxWidth(node: Workflow['nodes'][number], density: 'full' | 'compact' | 'mini' = 'full'): number {
  if (density === 'mini') {
    // No border, no denial bang, no summary — just "glyph id".
    const content = Math.max(node.id.length + 2, MINI_MIN_BOX_CONTENT);
    return Math.min(content, MINI_MAX_BOX_CONTENT);
  }
  // +4 on the title row leaves room for the status glyph and the denial bang.
  const content = Math.max(
    node.id.length + 4,
    node.type.displayName.length + 2,
    // +1 for the leading space every content row is drawn with.
    plannedSummary(node).length + 1,
    MIN_BOX_CONTENT,
  );
  return Math.min(content, MAX_BOX_CONTENT) + 2;
}

export interface LayoutOptions {
  /**
   * Card density. Uniform rather than per-node so the graph doesn't reflow
   * as focus moves; the full detail of one node is a keypress away in the
   * detail panel. Defaults to 'full'.
   */
  density?: 'full' | 'compact' | 'mini';
}

/**
 * Left-to-right auto-layout in dependency order: a node's layer is the
 * longest path from any root, so every node is drawn after all of its
 * dependencies.
 */
export function computeLayout(
  workflow: Workflow,
  overrides?: PositionOverrides,
  options: LayoutOptions = {},
): Layout {
  const boxHeight =
    options.density === 'mini' ? MINI_BOX_HEIGHT : options.density === 'compact' ? COMPACT_BOX_HEIGHT : BOX_HEIGHT;
  const layerOf = new Map<string, number>();
  for (const id of workflow.order) {
    const deps = workflow.graph.directDependencies(id);
    const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => layerOf.get(d)! + 1));
    layerOf.set(id, layer);
  }

  const layers = new Map<number, string[]>();
  for (const id of workflow.order) {
    const l = layerOf.get(id)!;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(id);
  }

  const widths = new Map<string, number>();
  for (const node of workflow.nodes) {
    widths.set(node.id, boxWidth(node, options.density ?? 'full'));
  }

  const boxes = new Map<string, NodeBox>();
  let x = 0;
  const layerCount = Math.max(...layers.keys()) + 1;
  for (let l = 0; l < layerCount; l++) {
    const ids = layers.get(l) ?? [];
    const layerWidth = Math.max(...ids.map((id) => widths.get(id)!), 0);
    ids.forEach((id, row) => {
      boxes.set(id, {
        id,
        x,
        y: row * (boxHeight + GAP_Y),
        w: widths.get(id)!,
        h: boxHeight,
        layer: l,
      });
    });
    x += layerWidth + GAP_X;
  }

  if (overrides) {
    for (const [id, { dx, dy }] of overrides) {
      const box = boxes.get(id);
      if (box) {
        box.x = Math.max(0, box.x + dx);
        box.y = Math.max(0, box.y + dy);
      }
    }
  }

  let width = 0;
  let height = 0;
  for (const box of boxes.values()) {
    width = Math.max(width, box.x + box.w);
    height = Math.max(height, box.y + box.h);
  }
  return { boxes, width, height };
}

export interface Viewport {
  ox: number;
  oy: number;
  width: number;
  height: number;
}

/** Adjust viewport offsets so `box` is fully visible (focus scrolls into view). */
export function scrollIntoView(box: NodeBox, viewport: Viewport): { ox: number; oy: number } {
  let { ox, oy } = viewport;
  if (box.x < ox) ox = box.x;
  if (box.x + box.w > ox + viewport.width) ox = box.x + box.w - viewport.width;
  if (box.y < oy) oy = box.y;
  if (box.y + box.h > oy + viewport.height) oy = box.y + box.h - viewport.height;
  return { ox: Math.max(0, ox), oy: Math.max(0, oy) };
}

/**
 * Focus-mode centering: unlike scrollIntoView's minimal nudge, this always
 * repositions the viewport so the focused box lands at a fixed anchor point.
 * Deliberately unclamped — the caller composes this with clampOffset (see
 * panBy) so a box near the graph's edge still just stops at the edge.
 */
export function centerOnBox(box: NodeBox, viewport: { width: number; height: number }): { ox: number; oy: number } {
  return {
    ox: box.x - Math.round(viewport.width * FOCUS_ANCHOR_X_FRACTION),
    oy: box.y - FOCUS_ANCHOR_Y_ROWS,
  };
}

/**
 * Hold the viewport over the graph. Panning is otherwise unbounded in the
 * positive direction, and a canvas panned into empty space gives no clue
 * which way the graph went — the offsets stop one screen short of the far
 * edge so there is always something drawn.
 */
export function clampOffset(
  layout: Layout,
  viewport: { ox: number; oy: number; width: number; height: number },
): { ox: number; oy: number } {
  const maxOx = Math.max(0, layout.width - viewport.width);
  const maxOy = Math.max(0, layout.height - viewport.height);
  return {
    ox: Math.min(Math.max(0, viewport.ox), maxOx),
    oy: Math.min(Math.max(0, viewport.oy), maxOy),
  };
}

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
export function offscreenCounts(
  layout: Layout,
  viewport: { ox: number; oy: number; width: number; height: number },
): OffscreenCounts {
  const counts: OffscreenCounts = { left: 0, right: 0, up: 0, down: 0 };
  for (const box of layout.boxes.values()) {
    if (box.x + box.w <= viewport.ox) counts.left++;
    else if (box.x >= viewport.ox + viewport.width) counts.right++;
    if (box.y + box.h <= viewport.oy) counts.up++;
    else if (box.y >= viewport.oy + viewport.height) counts.down++;
  }
  return counts;
}

export function hitTest(layout: Layout, x: number, y: number): string | null {
  for (const box of layout.boxes.values()) {
    if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) return box.id;
  }
  return null;
}
