import type { NodeStatus, RunState } from '../runstate/types.js';
import type { Workflow } from '../workflow/load.js';
import type { Layout, Viewport } from './layout.js';

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
  focus: '\x1b[1;36m',
  blocked: '\x1b[31;1m',
  // Return paths read as a different kind of line from forward edges.
  loopback: '\x1b[35m',
  'loopback-fired': '\x1b[1;35m',
};
const RESET = '\x1b[0m';

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

/** Render the workflow graph (boxes + elbow edges) onto a character grid. */
export function renderGraph(
  workflow: Workflow,
  layout: Layout,
  runState: RunState,
  focusedId: string | null,
): Grid {
  const loopbacks = workflow.graph.allLoopbacks();
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

    put(grid, box.x, box.y, `╭${'─'.repeat(inner)}╮`, style);
    const glyph = STATUS_GLYPHS[state.status];
    const blocked = state.denials > 0 ? ' !' : '';
    const title = ` ${glyph} ${node.id}${blocked}`.slice(0, inner).padEnd(inner);
    put(grid, box.x, box.y + 1, '│', style);
    put(grid, box.x + 1, box.y + 1, title, style);
    if (state.denials > 0) {
      const bangAt = box.x + 1 + ` ${glyph} ${node.id} `.length;
      put(grid, bangAt, box.y + 1, '!', 'blocked');
    }
    put(grid, box.x + box.w - 1, box.y + 1, '│', style);
    const typeLabel = ` ${node.type.displayName}`.slice(0, inner).padEnd(inner);
    put(grid, box.x, box.y + 2, '│', style);
    put(grid, box.x + 1, box.y + 2, typeLabel, focused ? 'focus' : 'dim');
    // Only a node a loop-back has re-run carries a badge; a first attempt is
    // the ordinary case and says nothing.
    const attempt = state.attempt ?? 1;
    if (attempt > 1) {
      const badge = `↻${attempt}`;
      put(grid, box.x + box.w - 1 - badge.length, box.y + 2, badge, 'loopback-fired');
    }
    put(grid, box.x + box.w - 1, box.y + 2, '│', style);
    put(grid, box.x, box.y + 3, `╰${'─'.repeat(inner)}╯`, style);
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
