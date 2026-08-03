import type { ActivityEntry, NodeStatus, RunState } from '../runstate/types.js';
import type { Workflow } from '../workflow/load.js';
import { resolveNodeModel } from '../workflow/modelResolution.js';
import { BOX_HEIGHT, type Layout, type Viewport } from './layout.js';
import { nodeMetrics, nodeSubtitle, spinnerFrame } from './nodeCard.js';
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
  // A skill badge is a standing config choice, not a transient run signal —
  // dim like the model badge, but yellow so it doesn't read as identical.
  'skill-badge': '\x1b[33m',
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
    const sx = from.x + from.w;
    const sy = from.y + 1;
    const tx = to.x - 1;
    const ty = to.y + 1;
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

    for (let y = from.y + from.h; y < bandY; y++) put(grid, sx, y, '╎', style);
    put(grid, sx, bandY, '╯', style);
    const [left, right] = tx < sx ? [tx, sx] : [sx, tx];
    for (let x = left + 1; x < right; x++) put(grid, x, bandY, '╌', style);
    put(grid, tx, bandY, '╰', style);
    for (let y = to.y + to.h + 1; y < bandY; y++) put(grid, tx, y, '╎', style);
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
    // A card too short for the type/subtitle/metrics rows is a compact card:
    // border, title, border. See COMPACT_BOX_HEIGHT.
    const compact = box.h < BOX_HEIGHT;

    put(grid, box.x, box.y, `╭${'─'.repeat(inner)}╮`, style);
    // A running node's glyph animates, so a stalled node is visibly distinct
    // from a working one without reading anything else on the card.
    const glyph = state.status === 'running' ? spinnerFrame(anim.frame) : STATUS_GLYPHS[state.status];
    const blocked = state.denials > 0 ? ' !' : '';
    const title = fit(` ${glyph} ${node.id}${blocked}`, inner).padEnd(inner);
    put(grid, box.x, box.y + 1, '│', style);
    put(grid, box.x + 1, box.y + 1, title, style);
    if (state.denials > 0) {
      const bangAt = box.x + 1 + ` ${glyph} ${node.id} `.length;
      put(grid, bangAt, box.y + 1, '!', 'blocked');
    }
    put(grid, box.x + box.w - 1, box.y + 1, '│', style);

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
      put(grid, box.x, box.y + box.h - 1, `╰${'─'.repeat(inner)}╯`, style);
      continue;
    }

    const typeLabel = fit(` ${node.type.displayName}`, inner).padEnd(inner);
    put(grid, box.x, box.y + 2, '│', style);
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
    put(grid, box.x + box.w - 1, box.y + 2, '│', style);

    // Subtitle: what the node is doing / produced / will do. Never the type
    // name again — that's the row above.
    const subtitle = nodeSubtitle(node, state, activityByNode.get(node.id) ?? [], anim.frame, inner - 1);
    const subtitleStyle =
      state.status === 'error' ? 'red' : state.status === 'running' ? 'label' : 'dim';
    put(grid, box.x, box.y + 3, '│', style);
    put(grid, box.x + 1, box.y + 3, fit(` ${subtitle}`, inner).padEnd(inner), focused ? 'focus' : subtitleStyle);
    put(grid, box.x + box.w - 1, box.y + 3, '│', style);

    // Metrics: tokens burned and time spent, live while running.
    const metrics = nodeMetrics(state, anim.now);
    put(grid, box.x, box.y + 4, '│', style);
    put(
      grid,
      box.x + 1,
      box.y + 4,
      fit(` ${metrics}`, inner).padEnd(inner),
      state.status === 'running' ? 'meter' : 'dim',
    );
    put(grid, box.x + box.w - 1, box.y + 4, '│', style);

    put(grid, box.x, box.y + 5, `╰${'─'.repeat(inner)}╯`, style);
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
