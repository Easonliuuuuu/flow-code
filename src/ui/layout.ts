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
/**
 * Rows reserved between two wrapped bands — see `computeLayout`'s `wrapWidth`
 * option. Wider than `GAP_Y` because a wrap edge needs room to route through:
 * one blank row, one lane row for the bend, one arrow row into the next
 * band's top border.
 */
export const BAND_GAP_Y = 3;

/** Mini-card width bounds — much narrower than a full/compact card's, since it holds no subtitle or metrics. */
export const MINI_MIN_BOX_CONTENT = 6;
export const MINI_MAX_BOX_CONTENT = 16;

/**
 * Compact-card width floor. Narrower than a full card's `MIN_BOX_CONTENT`
 * since there's no subtitle or type-name row to size for — a long
 * `instructions` or `topic` no longer widens the box the way it does at full
 * density. What's left is the title (glyph, id, denial bang) plus enough
 * room on that same row for a typical `↑tokens ↓tokens` reading to ride its
 * right edge; metrics longer than that are dropped gracefully rather than
 * clipped (see canvas.ts), so this doesn't have to fit the worst case.
 */
export const COMPACT_MIN_BOX_CONTENT = 18;

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
  /** Which wrapped band this box's layer landed in — see `computeLayout`'s
   * `wrapWidth` option. Always 0 when the graph isn't wrapped. */
  band: number;
  /**
   * Bottom edge of this box's whole *band* — not just this box's own row.
   * A wrap edge's lane has to clear every layer in the band it's leaving,
   * not just the single (validated) layer it happens to start from: that
   * layer can sit at the band's top while an earlier, taller layer (a
   * fan-out, say) reaches further down. Routing the lane off `from.y +
   * from.h` instead cuts straight through that layer's boxes.
   */
  bandBottom: number;
}

export interface Layout {
  boxes: Map<string, NodeBox>;
  width: number;
  height: number;
  /**
   * The graph's width before any drag overrides were applied. Horizontal
   * offsets are stored as a fraction of this (see PositionOverrides), and it
   * has to be the *un-dragged* width or dragging one node would rescale
   * everybody else's offset along with it.
   */
  baseWidth: number;
}

/**
 * The zoom axis, coarsest-last. Card density is the only thing a terminal can
 * actually zoom — there are no half-cells — so these three are the stops.
 */
export const ZOOM_DENSITIES = ['full', 'compact', 'mini'] as const;
export type Density = (typeof ZOOM_DENSITIES)[number];
export const MAX_ZOOM = ZOOM_DENSITIES.length - 1;

/** Clamp an arbitrary integer onto the zoom axis. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom)));
}

/**
 * Session-only position overrides from mouse dragging; never persisted.
 *
 * Both axes are stored in units that survive a zoom, because arranging the
 * graph zoomed out and then zooming in to work is the whole point of having a
 * zoom: a raw cell offset recorded at one density and replayed at another
 * lands somewhere else entirely.
 *
 * `dyRows` is in card pitches, which differ per density (7 rows full, 4
 * compact, 2 mini) — cells would overshoot by that ratio and stack dragged
 * nodes on top of each other. `dxFrac` is a fraction of the graph's own
 * un-dragged width at the density it's replayed against, so a node parked a
 * third of the way across the graph stays a third of the way across it at
 * every zoom, even though each density's columns are a different width.
 */
export type PositionOverrides = Map<string, { dxFrac: number; dyRows: number }>;

/** Cell distance between the tops of two stacked cards at this density. */
export function rowPitch(density: Density = 'full'): number {
  const boxHeight =
    density === 'mini' ? MINI_BOX_HEIGHT : density === 'compact' ? COMPACT_BOX_HEIGHT : BOX_HEIGHT;
  return boxHeight + GAP_Y;
}

/**
 * Wide enough for the text the card actually wants to show. The subtitle is
 * measured from `plannedSummary`, which is a pure function of the node's
 * config: a width derived from the *live* subtitle instead would resize
 * boxes — and so reflow the whole graph — every time a running agent
 * reported a different tool call.
 */
function boxWidth(node: Workflow['nodes'][number], density: Density = 'full'): number {
  if (density === 'mini') {
    // No border, no denial bang, no summary — just "glyph id".
    const content = Math.max(node.id.length + 2, MINI_MIN_BOX_CONTENT);
    return Math.min(content, MINI_MAX_BOX_CONTENT);
  }
  if (density === 'compact') {
    // Border, title (glyph + id + denial bang) — no type-name or subtitle
    // row to size for, unlike full. +4 leaves room for the glyph and bang,
    // same as full's title row; +2 for the border.
    const content = Math.max(node.id.length + 4, COMPACT_MIN_BOX_CONTENT);
    return Math.min(content, MAX_BOX_CONTENT) + 2;
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
  density?: Density;
  /**
   * When set, layers wrap into bands rather than running off to the right
   * forever: once a band's accumulated width would exceed this, the next
   * layer starts a new band back at x=0, one `BAND_GAP_Y` below. Left
   * undefined, the graph lays out as one flat band exactly as before —
   * callers opt individual density passes into wrapping, `computeLayout`
   * doesn't decide that itself.
   *
   * Wrapping only takes effect if every band boundary is a shape a wrap edge
   * can actually route without dodging another band's own boxes: single
   * node at the end of one band, single node at the start of the next, no
   * loop-back crossing it. If any boundary fails that, the whole layout
   * falls back to one flat band rather than wrapping some boundaries and not
   * others — see `bandsWrapCleanly`.
   */
  wrapWidth?: number;
}

/**
 * Assigns each layer to a band so no band's accumulated width exceeds
 * `wrapWidth`. One band (index 0) for every layer when `wrapWidth` is
 * undefined — today's unwrapped behavior.
 */
function assignBands(layerWidths: number[], wrapWidth: number | undefined): number[] {
  if (wrapWidth === undefined) return layerWidths.map(() => 0);
  const bands: number[] = [];
  let band = 0;
  let bandX = 0;
  for (const w of layerWidths) {
    // Never wrap before a band's first layer — a lone layer wider than
    // wrapWidth still has to go somewhere.
    if (bandX > 0 && bandX + w > wrapWidth) {
      band += 1;
      bandX = 0;
    }
    bands.push(band);
    bandX += w + GAP_X;
  }
  return bands;
}

/**
 * True only if every edge that crosses a band boundary can be drawn as the
 * one shape `renderGraph`'s wrap edge knows how to route: from the *only*
 * node in its band's last layer, to the *only* node in the next band's
 * first layer, skipping no band in between, and never a loop-back (those
 * already have their own return-path drawing and aren't taught this lane).
 * Anything else — a fan-out sitting right at the boundary, a skip-layer
 * edge, a loop-back that would cross it — fails this for the *whole*
 * layout, not just that boundary; see `wrapWidth`.
 */
function bandsWrapCleanly(
  workflow: Workflow,
  layerOf: Map<string, number>,
  layerBand: number[],
  layers: Map<number, string[]>,
): boolean {
  const bandFirstLayer = new Map<number, number>();
  const bandLastLayer = new Map<number, number>();
  layerBand.forEach((band, layer) => {
    if (!bandFirstLayer.has(band)) bandFirstLayer.set(band, layer);
    bandLastLayer.set(band, layer);
  });

  for (const edge of workflow.edges) {
    const fromLayer = layerOf.get(edge.from);
    const toLayer = layerOf.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined) continue;
    const fromBand = layerBand[fromLayer]!;
    const toBand = layerBand[toLayer]!;
    if (fromBand === toBand) continue; // same band: today's routing already handles this
    if (edge.loopback) return false;
    if (toBand !== fromBand + 1) return false;
    if (fromLayer !== bandLastLayer.get(fromBand)) return false;
    if (toLayer !== bandFirstLayer.get(toBand)) return false;
    if ((layers.get(fromLayer)?.length ?? 0) !== 1) return false;
    if ((layers.get(toLayer)?.length ?? 0) !== 1) return false;
  }
  return true;
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

  const layerCount = Math.max(...layers.keys()) + 1;
  const layerWidths = Array.from({ length: layerCount }, (_, l) => {
    const ids = layers.get(l) ?? [];
    return Math.max(...ids.map((id) => widths.get(id)!), 0);
  });

  let layerBand = assignBands(layerWidths, options.wrapWidth);
  if (options.wrapWidth !== undefined && !bandsWrapCleanly(workflow, layerOf, layerBand, layers)) {
    layerBand = layerWidths.map(() => 0);
  }

  const boxes = new Map<string, NodeBox>();
  let bandX = 0;
  let bandTop = 0;
  let bandHeight = 0;
  let currentBand = 0;
  for (let l = 0; l < layerCount; l++) {
    const ids = layers.get(l) ?? [];
    const band = layerBand[l]!;
    if (band !== currentBand) {
      bandTop += bandHeight + BAND_GAP_Y;
      bandX = 0;
      bandHeight = 0;
      currentBand = band;
    }
    if (ids.length > 0) bandHeight = Math.max(bandHeight, ids.length * (boxHeight + GAP_Y) - GAP_Y);
    ids.forEach((id, row) => {
      boxes.set(id, {
        id,
        x: bandX,
        y: bandTop + row * (boxHeight + GAP_Y),
        w: widths.get(id)!,
        h: boxHeight,
        layer: l,
        band,
        bandBottom: 0, // filled in below, once every layer's height is known
      });
    });
    bandX += layerWidths[l]! + GAP_X;
  }

  // A box's own layer can be shorter than another layer elsewhere in its
  // band (a fan-out earlier in the same band, say) — `bandBottom` has to be
  // the tallest of them, which isn't known until every layer's been placed.
  const bandBottom = new Map<number, number>();
  for (const box of boxes.values()) {
    bandBottom.set(box.band, Math.max(bandBottom.get(box.band) ?? 0, box.y + box.h));
  }
  for (const box of boxes.values()) box.bandBottom = bandBottom.get(box.band)!;

  // Captured before overrides move anything: this is the yardstick `dxFrac`
  // is measured against, and it has to mean the same thing on every call or a
  // node's own drag would rescale it.
  let baseWidth = 0;
  for (const box of boxes.values()) baseWidth = Math.max(baseWidth, box.x + box.w);

  if (overrides) {
    const pitch = rowPitch(options.density ?? 'full');
    for (const [id, { dxFrac, dyRows }] of overrides) {
      const box = boxes.get(id);
      if (box) {
        // A safety net, not the real clamp: the drag handler limits the delta
        // it stores against the box's current position, so what is banked and
        // what is drawn stay the same number. This only catches an offset
        // recorded at one zoom and replayed at another whose base position is
        // nearer the origin.
        box.x = Math.max(0, box.x + Math.round(dxFrac * baseWidth));
        box.y = Math.max(0, box.y + Math.round(dyRows * pitch));
      }
    }
  }

  let width = 0;
  let height = 0;
  for (const box of boxes.values()) {
    width = Math.max(width, box.x + box.w);
    height = Math.max(height, box.y + box.h);
  }
  return { boxes, width, height, baseWidth };
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

/**
 * Which node is under this canvas cell.
 *
 * `drawOrder` must be the order `renderGraph` paints boxes in (i.e.
 * `workflow.nodes`), because painting is last-wins: where two dragged cards
 * overlap, the one drawn later is the one you can see. Without it this walks
 * the layout's own layer order instead, and the two disagree often enough
 * that clicking a card stacked on top of another grabbed the one underneath —
 * which, once arranging nodes by hand is a normal thing to do, means the node
 * you just dropped somewhere is the one you can no longer pick up. Optional
 * only so callers that never overlap boxes needn't thread it through.
 */
export function hitTest(
  layout: Layout,
  x: number,
  y: number,
  drawOrder?: readonly string[],
): string | null {
  const hits = (box: NodeBox): boolean =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  if (drawOrder) {
    for (let i = drawOrder.length - 1; i >= 0; i--) {
      const box = layout.boxes.get(drawOrder[i]!);
      if (box && hits(box)) return box.id;
    }
    return null;
  }
  for (const box of layout.boxes.values()) {
    if (hits(box)) return box.id;
  }
  return null;
}
