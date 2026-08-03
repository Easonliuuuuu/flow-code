import type { Workflow } from '../workflow/load.js';

/** Border, title, type/model, live subtitle, metrics, border — see renderGraph. */
export const BOX_HEIGHT = 6;
export const GAP_X = 5;
export const GAP_Y = 1;

/**
 * Boxes are sized for their content rows, not just their title: the subtitle
 * and metrics lines carry real text, and a box narrow enough to fit only an
 * id would truncate all of it away.
 */
export const MIN_BOX_CONTENT = 22;

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

function boxWidth(id: string, typeName: string): number {
  // +4 on the title row leaves room for the status glyph and the denial bang.
  return Math.max(id.length + 4, typeName.length + 2, MIN_BOX_CONTENT) + 2;
}

/**
 * Left-to-right auto-layout in dependency order: a node's layer is the
 * longest path from any root, so every node is drawn after all of its
 * dependencies.
 */
export function computeLayout(workflow: Workflow, overrides?: PositionOverrides): Layout {
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
    widths.set(node.id, boxWidth(node.id, node.type.displayName));
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
        y: row * (BOX_HEIGHT + GAP_Y),
        w: widths.get(id)!,
        h: BOX_HEIGHT,
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
