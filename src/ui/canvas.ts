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
  const grid = makeGrid(layout.width + 2, layout.height + 1);

  // Edges under boxes.
  for (const edge of workflow.edges) {
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
