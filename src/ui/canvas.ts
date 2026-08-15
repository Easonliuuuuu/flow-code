import { isRejectedGate } from '../runstate/types.js';
import type { ActivityEntry, NodeRunState, NodeStatus, RunState } from '../runstate/types.js';
import type { Workflow } from '../workflow/load.js';
import { resolveNodeModel } from '../workflow/modelResolution.js';
import { BOX_HEIGHT, MINI_BOX_HEIGHT, type Layout, type NodeBox, type Viewport } from './layout.js';
import { delegationBadge, nodeMetrics, nodeSubtitle, spinnerFrame } from './nodeCard.js';
import { fitText as fit } from './textwrap.js';

export interface Cell {
  ch: string;
  style: string;
}

export type Grid = Cell[][];

export const STATUS_GLYPHS: Record<NodeStatus, string> = {
  idle: '○',
  running: '◐',
  waiting: '◆',
  done: '●',
  error: '✖',
  // Deliberately distinct from idle: "will not run" vs "not yet started".
  skipped: '⊘',
};

/**
 * What a node's status looks like on the card. A running node animates, so a
 * stalled node is visibly distinct from a working one without reading anything
 * else. A rejected gate is the one case where the glyph does not follow the
 * status: it reaches `done`, but drawing it with the same filled dot as an
 * approved one would say the run got what it wanted.
 */
function statusGlyphFor(state: NodeRunState, frame: number): string {
  if (state.status === 'running') return spinnerFrame(frame);
  if (isRejectedGate(state)) return STATUS_GLYPHS.error;
  return STATUS_GLYPHS[state.status];
}

/**
 * Lifecycle order, for anything that summarises a whole run as counts per
 * status (the header's `○ 4  ◐ 1  ● 3`). Derived from the order statuses
 * actually occur in, so a status only ever appears to the *right* of the ones
 * a run passes through before it — segments then hold their position as the
 * run progresses instead of being reshuffled by whichever node happened to
 * reach a given status first.
 */
export const STATUS_ORDER: NodeStatus[] = ['idle', 'running', 'waiting', 'done', 'error', 'skipped'];

/**
 * Card border glyphs. The focused card is drawn in heavy rules rather than a
 * brighter colour alone: focus and `running` are both cyan, so on a card that
 * is either, colour answers "which of the two is this?" with a shade. A change
 * of shape answers it at a glance — and keeps answering it on a terminal
 * theme with a washed-out palette, or for a reader who can't separate the two
 * hues at all.
 */
const BORDERS = {
  normal: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  focus: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
} as const;

const STATUS_STYLES: Record<NodeStatus, string> = {
  idle: 'dim',
  running: 'cyan',
  waiting: 'yellow',
  done: 'green',
  error: 'red',
  skipped: 'dim-strike',
};

const ANSI: Record<string, string> = {
  dim: '\x1b[90m',
  'dim-strike': '\x1b[90;2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  edge: '\x1b[90m',
  label: '',
  // The live metrics row of a running node: bright enough to draw the eye to
  // whatever is actually consuming tokens right now.
  meter: '\x1b[96m',
  focus: '\x1b[1;36m',
  blocked: '\x1b[31;1m',
  // Return paths read as a different kind of line from forward edges.
  loopback: '\x1b[35m',
  'loopback-fired': '\x1b[1;35m',
  // A band-wrap edge is still a forward edge, just routed through a reserved
  // lane instead of straight across — its own color so it doesn't read as a
  // stray loop-back or a plain elbow with a bug in it.
  wrap: '\x1b[94m',
  // A skill badge is a standing config choice, not a transient run signal —
  // dim like the model badge, but yellow so it doesn't read as identical.
  'skill-badge': '\x1b[33m',
  // Where a loop-back's vertical run passes through a wrap lane on its way to
  // the reserved row below the whole graph — see `putLoopbackRun`. Neutral so
  // it reads as "two unrelated lines cross here", not as a piece of either.
  crossing: '\x1b[37m',
};
const RESET = '\x1b[0m';

/**
 * The model a node's box should badge, or null when it's running on the
 * run-wide default. `workflow.settings.model` already carries the provider
 * fallback baked in by the time the UI sees it (see `cmdRun` in `cli.ts`),
 * so it alone is "the effective default a node without its own override
 * would get" — no separate provider-default plumbing needed here, only in
 * the detail view's origin/provenance line, which the App computes itself.
 */
export function nodeModelBadge(workflow: Workflow, nodeId: string): string | null {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const resolved = resolveNodeModel(node.config, workflow.settings.model, workflow.settings.model);
  if (resolved.model === undefined || resolved.model === workflow.settings.model) return null;
  return resolved.model;
}

/**
 * `»name` for one attached skill, `»×n` for several — the full list lives in
 * the detail panel. `»` rather than an emoji glyph: `put` below lays out one
 * grid cell per JS character, and most emoji (unlike the box-drawing and
 * dingbat glyphs used elsewhere on the card) render as two terminal columns,
 * which pushes the row past the box's right border.
 */
export function nodeSkillBadge(workflow: Workflow, nodeId: string): string | null {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node || node.skills.length === 0) return null;
  return node.skills.length === 1 ? `»${node.skills[0]!.id}` : `»×${node.skills.length}`;
}

export function makeGrid(width: number, height: number): Grid {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ ch: ' ', style: 'label' })),
  );
}

function put(grid: Grid, x: number, y: number, text: string, style: string): void {
  const row = grid[y];
  if (!row) return;
  for (let i = 0; i < text.length; i++) {
    const cell = row[x + i];
    if (cell) {
      cell.ch = text[i]!;
      cell.style = style;
    }
  }
}

/**
 * A band-to-band wrap edge: down out of the source's bottom, across a lane
 * below the *whole band* — not just below the source box's own row, which
 * can sit above other, taller layers in the same band (a fan-out earlier in
 * it, say) and cut straight through them — back down into the target's top.
 * The same reserved-lane shape the loop-back edges below use, just pointed
 * forward. `layout.ts`'s `bandBottom` plus `BAND_GAP_Y` (3) guarantees the
 * lane always has room, regardless of how the source's own row compares to
 * its band's tallest layer.
 */
function drawWrapEdge(grid: Grid, from: NodeBox, to: NodeBox, style: string): void {
  const sx = from.x + Math.floor(from.w / 2);
  const tx = to.x + Math.floor(to.w / 2);
  const laneY = from.bandBottom + 1;
  for (let y = from.y + from.h; y < laneY; y++) put(grid, sx, y, '│', style);
  if (sx === tx) {
    put(grid, sx, laneY, '│', style);
  } else {
    put(grid, sx, laneY, sx > tx ? '╯' : '╰', style);
    const [left, right] = sx < tx ? [sx, tx] : [tx, sx];
    for (let x = left + 1; x < right; x++) put(grid, x, laneY, '─', style);
    put(grid, tx, laneY, sx > tx ? '╭' : '╮', style);
  }
  for (let y = laneY + 1; y < to.y - 1; y++) put(grid, tx, y, '│', style);
  put(grid, tx, to.y - 1, '▼', style);
}

/**
 * A loop-back's vertical run, from a box's edge down to its reserved row
 * below the whole graph. That row sits below every band, so a loop-back
 * whose nodes live above the last band has to pass through every wrap lane
 * between them on the way — band-wrap and loop-backs are laid out by two
 * independent allocators that don't know about each other's rows. Marking
 * the cell as an explicit crossing instead of just overwriting it keeps the
 * wrap edge legible instead of silently breaking wherever a loop-back
 * happens to run through its column.
 */
function putLoopbackRun(grid: Grid, x: number, y0: number, y1: number, style: string): void {
  for (let y = y0; y < y1; y++) {
    if (grid[y]?.[x]?.style === 'wrap') put(grid, x, y, '┼', 'crossing');
    else put(grid, x, y, '╎', style);
  }
}

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
export function renderGraph(
  workflow: Workflow,
  layout: Layout,
  runState: RunState,
  focusedId: string | null,
  anim: AnimationState = { frame: 0, now: Date.now() },
): Grid {
  const loopbacks = workflow.graph.allLoopbacks();
  // Bucketed once per render: every running box wants only its own last entry,
  // and the activity log is run-wide and can be long.
  const activityByNode = new Map<string, ActivityEntry[]>();
  for (const entry of runState.activity) {
    const list = activityByNode.get(entry.nodeId);
    if (list) list.push(entry);
    else activityByNode.set(entry.nodeId, [entry]);
  }
  // Each return path gets its own row below the boxes so they never collide
  // with each other or with the forward elbows between the same two nodes.
  const bandTop = layout.height + 1;
  const grid = makeGrid(layout.width + 2, bandTop + loopbacks.length + 1);

  // Edges under boxes. Loop-backs are not dependencies and are drawn below.
  for (const edge of workflow.edges.filter((e) => !e.loopback)) {
    const from = layout.boxes.get(edge.from)!;
    const to = layout.boxes.get(edge.to)!;
    if (from.band !== to.band) {
      // Wrapped layout only ever produces this for a band's last (single)
      // node into the next band's first (single) node — see
      // `bandsWrapCleanly` in layout.ts — so there's exactly one shape to
      // draw here, not a general router.
      drawWrapEdge(grid, from, to, 'wrap');
      continue;
    }
    const sx = from.x + from.w;
    // The title row for a full/compact card, or its only row for a mini one.
    const sy = from.y + Math.min(1, from.h - 1);
    const tx = to.x - 1;
    const ty = to.y + Math.min(1, to.h - 1);
    const mid = sx + Math.max(1, Math.floor((tx - sx) / 2));
    for (let x = sx; x < mid; x++) put(grid, x, sy, '─', 'edge');
    if (sy !== ty) {
      put(grid, mid, sy, sy < ty ? '┐' : '┘', 'edge');
      const [y0, y1] = sy < ty ? [sy + 1, ty - 1] : [ty + 1, sy - 1];
      for (let y = y0; y <= y1; y++) put(grid, mid, y, '│', 'edge');
      put(grid, mid, ty, sy < ty ? '└' : '┌', 'edge');
    } else {
      put(grid, mid, sy, '─', 'edge');
    }
    for (let x = mid + 1; x < tx; x++) put(grid, x, ty, '─', 'edge');
    put(grid, tx, ty, '▶', 'edge');
  }

  // Return paths: down out of the failing node, back along a reserved row,
  // then up into the node execution resumes at.
  loopbacks.forEach((loop, i) => {
    const from = layout.boxes.get(loop.from);
    const to = layout.boxes.get(loop.to);
    if (!from || !to) return;
    const bandY = bandTop + i;
    const sx = from.x + Math.floor(from.w / 2);
    const tx = to.x + Math.floor(to.w / 2);
    // A loop that has actually fired is drawn brighter, and says so.
    const fired =
      (runState.nodes[loop.to]?.attempt ?? 1) > 1 &&
      (runState.nodes[loop.from]?.priorAttempts?.length ?? 0) > 0;
    const style = fired ? 'loopback-fired' : 'loopback';

    putLoopbackRun(grid, sx, from.y + from.h, bandY, style);
    put(grid, sx, bandY, '╯', style);
    const [left, right] = tx < sx ? [tx, sx] : [sx, tx];
    for (let x = left + 1; x < right; x++) put(grid, x, bandY, '╌', style);
    put(grid, tx, bandY, '╰', style);
    putLoopbackRun(grid, tx, to.y + to.h + 1, bandY, style);
    put(grid, tx, to.y + to.h, '▲', style);

    if (fired) {
      const label = ` ↻ retry from ${loop.from} `;
      const span = right - left - 1;
      if (span >= label.length) {
        put(grid, left + 1 + Math.floor((span - label.length) / 2), bandY, label, style);
      }
    }
  });

  // Boxes.
  for (const node of workflow.nodes) {
    const box = layout.boxes.get(node.id)!;
    const state = runState.nodes[node.id]!;
    const focused = node.id === focusedId;
    const style = focused ? 'focus' : STATUS_STYLES[state.status];
    const inner = box.w - 2;
    // A single borderless row: status glyph + id, nothing else. See MINI_BOX_HEIGHT.
    const mini = box.h <= MINI_BOX_HEIGHT;
    // A card too short for the type/subtitle/metrics rows is a compact card:
    // border, title, border. See COMPACT_BOX_HEIGHT.
    const compact = !mini && box.h < BOX_HEIGHT;

    if (mini) {
      const glyph = statusGlyphFor(state, anim.frame);
      put(grid, box.x, box.y, fit(`${glyph} ${node.id}`, box.w).padEnd(box.w), style);
      continue;
    }

    const border = focused ? BORDERS.focus : BORDERS.normal;
    put(grid, box.x, box.y, `${border.tl}${border.h.repeat(inner)}${border.tr}`, style);
    // A running node's glyph animates, so a stalled node is visibly distinct
    // from a working one without reading anything else on the card.
    const glyph = statusGlyphFor(state, anim.frame);
    const blocked = state.denials > 0 ? ' !' : '';
    const title = fit(` ${glyph} ${node.id}${blocked}${delegationBadge(state)}`, inner).padEnd(inner);
    put(grid, box.x, box.y + 1, border.v, style);
    put(grid, box.x + 1, box.y + 1, title, style);
    if (state.denials > 0) {
      const bangAt = box.x + 1 + ` ${glyph} ${node.id} `.length;
      put(grid, bangAt, box.y + 1, '!', 'blocked');
    }
    put(grid, box.x + box.w - 1, box.y + 1, border.v, style);

    if (compact) {
      // The rows that carried tokens and elapsed time are gone, so the
      // metrics ride on the right of the title row instead — a compact graph
      // still has to show which node is burning the run's budget.
      // Tokens and the clock if both fit, tokens alone if they don't — an
      // elided `↑1.2k ↓340 · …` would spend the row saying nothing.
      const room = inner - title.trimEnd().length - 1;
      const text = [nodeMetrics(state, anim.now), nodeMetrics(state, anim.now, { clock: false })].find(
        (m) => m.length > 0 && m.length <= room,
      );
      if (text) {
        put(
          grid,
          box.x + box.w - 1 - text.length,
          box.y + 1,
          text,
          state.status === 'running' ? 'meter' : 'dim',
        );
      }
      put(grid, box.x, box.y + box.h - 1, `${border.bl}${border.h.repeat(inner)}${border.br}`, style);
      continue;
    }

    const typeLabel = fit(` ${node.type.displayName}`, inner).padEnd(inner);
    put(grid, box.x, box.y + 2, border.v, style);
    put(grid, box.x + 1, box.y + 2, typeLabel, focused ? 'focus' : 'dim');
    // Only a node a loop-back has re-run carries a retry badge; a first
    // attempt is the ordinary case and says nothing. The retry badge takes
    // the corner over the model badge on the rare frame both would apply —
    // it's the rarer, more transient of the two, and the model is still
    // visible in the detail view.
    const attempt = state.attempt ?? 1;
    const modelBadge = nodeModelBadge(workflow, node.id);
    const skillBadge = nodeSkillBadge(workflow, node.id);
    if (attempt > 1) {
      const badge = fit(`↻${attempt}`, inner);
      put(grid, box.x + box.w - 1 - badge.length, box.y + 2, badge, 'loopback-fired');
    } else if (modelBadge) {
      const badge = fit(modelBadge, inner);
      put(grid, box.x + box.w - 1 - badge.length, box.y + 2, badge, focused ? 'focus' : 'dim');
    } else if (skillBadge) {
      const badge = fit(skillBadge, inner);
      put(grid, box.x + box.w - 1 - badge.length, box.y + 2, badge, focused ? 'focus' : 'skill-badge');
    }
    put(grid, box.x + box.w - 1, box.y + 2, border.v, style);

    // Subtitle: what the node is doing / produced / will do. Never the type
    // name again — that's the row above.
    const subtitle = nodeSubtitle(node, state, activityByNode.get(node.id) ?? [], anim.frame, inner - 1);
    const failed = state.status === 'error' || isRejectedGate(state);
    const subtitleStyle = failed ? 'red' : state.status === 'running' ? 'label' : 'dim';
    put(grid, box.x, box.y + 3, border.v, style);
    // Focus recolours the card cyan, which on a failed node used to take the
    // one red line on it with it — so the node you tabbed to *because* it
    // failed was the one node whose failure wasn't coloured as one. An error
    // outranks focus here; the heavy border still says which card is focused.
    put(
      grid,
      box.x + 1,
      box.y + 3,
      fit(` ${subtitle}`, inner).padEnd(inner),
      failed ? 'red' : focused ? 'focus' : subtitleStyle,
    );
    put(grid, box.x + box.w - 1, box.y + 3, border.v, style);

    // Metrics: tokens burned and time spent, live while running.
    const metrics = nodeMetrics(state, anim.now);
    put(grid, box.x, box.y + 4, border.v, style);
    put(
      grid,
      box.x + 1,
      box.y + 4,
      fit(` ${metrics}`, inner).padEnd(inner),
      state.status === 'running' ? 'meter' : 'dim',
    );
    put(grid, box.x + box.w - 1, box.y + 4, border.v, style);

    put(grid, box.x, box.y + 5, `${border.bl}${border.h.repeat(inner)}${border.br}`, style);
  }

  return grid;
}

/** Slice the grid through a viewport and emit ANSI-styled lines. */
export function gridToLines(grid: Grid, viewport: Viewport): string[] {
  const lines: string[] = [];
  for (let y = viewport.oy; y < viewport.oy + viewport.height; y++) {
    const row = grid[y];
    if (!row) {
      lines.push('');
      continue;
    }
    let line = '';
    let currentStyle = '';
    for (let x = viewport.ox; x < viewport.ox + viewport.width; x++) {
      const cell = row[x] ?? { ch: ' ', style: 'label' };
      if (cell.style !== currentStyle) {
        line += (currentStyle ? RESET : '') + (ANSI[cell.style] ?? '');
        currentStyle = cell.style;
      }
      line += cell.ch;
    }
    if (currentStyle) line += RESET;
    lines.push(line.trimEnd());
  }
  return lines;
}
