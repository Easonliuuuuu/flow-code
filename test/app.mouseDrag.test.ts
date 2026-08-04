import { render } from 'ink';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App, type ModelContext } from '../src/ui/App.js';
import { RunStateStore } from '../src/runstate/store.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import type { Workflow } from '../src/workflow/load.js';
import { WORKFLOW_RELATIVE_PATH } from '../src/workflow/load.js';
import { makeTempGitRepo, storeFor, workflowFromYaml } from './helpers.js';

/**
 * End-to-end coverage of canvas mouse handling: node dragging, and the badge
 * click that opens a picker. Both live inside App's own stdin listener rather
 * than a separately-mountable component, so — like the picker tests — this
 * drives a real Ink render against a fake TTY and reads the frames back.
 *
 * `impl` carries its own model so its card draws a badge, which is what makes
 * one of its rows click-sensitive in the first place.
 */
const WORKFLOW_YAML = `settings:
  model: sonnet

nodes:
  - id: impl
    type: implement
    config:
      instructions: do it
      model: haiku
  - id: rev
    type: review
  - id: verify
    type: review
  - id: polish
    type: review
  - id: ship
    type: review
edges:
  - { from: impl, to: rev }
  - { from: rev, to: verify }
  - { from: verify, to: polish }
  - { from: polish, to: ship }
`;

const ROWS = 30;
const COLUMNS = 100;

/** Header rows above the canvas — mirrors HEADER_ROWS in App.tsx. */
const HEADER_ROWS = 1;

interface FakeStdout extends NodeJS.WriteStream {
  frames: string[];
}

function fakeStdout(): FakeStdout {
  const frames: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as unknown as FakeStdout;
  Object.assign(out, { columns: COLUMNS, rows: ROWS, isTTY: true, frames });
  return out;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stream, { isTTY: true, setRawMode: () => stream, ref: () => {}, unref: () => {} });
  return stream;
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lastFrameLines(stdout: FakeStdout): string[] {
  const plain = stdout.frames.map((f) => f.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  return (plain.filter((f) => f.trim().length > 0).at(-1) ?? '').split('\n');
}

/**
 * The screen column a node's card is drawn at, read off the title row — the
 * one row that always carries `glyph id`. Reading it back from the frame
 * rather than recomputing the layout is the point: it catches a viewport pan
 * just as readily as a moved box, and a drag must not cause either for
 * anything but the node under the pointer.
 */
function columnOf(stdout: FakeStdout, id: string): number {
  for (const line of lastFrameLines(stdout).slice(HEADER_ROWS)) {
    const at = line.indexOf(`○ ${id}`);
    if (at >= 0) return at;
  }
  return -1;
}

/** SGR (1006) mouse sequences, in the protocol's 1-based cell coordinates. */
const press = (col: number, row: number): string => `\x1b[<0;${col};${row}M`;
const motion = (col: number, row: number): string => `\x1b[<32;${col};${row}M`;
const release = (col: number, row: number): string => `\x1b[<0;${col};${row}m`;
/** Wheel codes are 64/65; ctrl ORs in bit 16. */
const wheel = (dir: 'up' | 'down', col: number, row: number, ctrl = false): string =>
  `\x1b[<${64 + (dir === 'up' ? 0 : 1) + (ctrl ? 16 : 0)};${col};${row}M`;

/**
 * `impl` is the first node in topological order, so it is focused on mount
 * and sits at canvas (0, 0) — and centering on it clamps the viewport to the
 * origin. Its rows are therefore at fixed, known screen positions.
 */
const IMPL_TITLE_SGR_ROW = HEADER_ROWS + 1 + 1; // canvas y=1, 1-based
const IMPL_BADGE_SGR_ROW = HEADER_ROWS + 2 + 1; // canvas y=2, 1-based
const INSIDE_CARD_SGR_COL = 4;

function newRepoWithWorkflow(): { repoRoot: string; workflow: Workflow } {
  const repoRoot = makeTempGitRepo();
  mkdirSync(join(repoRoot, '.flow-code'), { recursive: true });
  writeFileSync(join(repoRoot, WORKFLOW_RELATIVE_PATH), WORKFLOW_YAML);
  return { repoRoot, workflow: workflowFromYaml(WORKFLOW_YAML) };
}

function mountApp(): {
  ports: UiInteractionPorts;
  stdout: FakeStdout;
  stdin: NodeJS.ReadStream;
  unmount: () => void;
} {
  const { repoRoot, workflow } = newRepoWithWorkflow();
  const store: RunStateStore = storeFor(workflow, repoRoot);
  const ports = new UiInteractionPorts();
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const modelContext: ModelContext = {
    providerId: 'claude',
    providerDefaultModel: undefined,
    workflowSettingsModel: 'sonnet',
  };
  const instance = render(
    React.createElement(App, {
      workflow,
      store,
      ports,
      modelContext,
      onExit: () => {},
      onInterrupt: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  return { ports, stdout, stdin, unmount: () => instance.unmount() };
}

/** One motion event per write, so each gets its own render — the shape the runaway showed up in. */
async function dragBy(stdin: NodeJS.ReadStream, startCol: number, row: number, cells: number): Promise<void> {
  const step = Math.sign(cells);
  for (let i = 1; i <= Math.abs(cells); i++) {
    stdin.write(motion(startCol + i * step, row));
    await settle();
  }
}

describe('canvas node dragging', () => {
  it('moves the node by exactly the pointer travel, and leaves the rest of the graph alone', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      // `verify` is a middle layer of a graph wider than the canvas, so
      // focusing it lands the viewport away from both ends — the only place a
      // re-center is free to pan at all. Dragging the first node proves
      // nothing: at x=0 the pan clamps away and the bug can't show itself.
      const grabCol = columnOf(stdout, 'verify') + 3;
      expect(grabCol).toBeGreaterThan(3);

      // The press focuses `verify` and centers on it before any motion; read
      // the positions back afterwards so the drag is measured from there.
      stdin.write(press(grabCol, IMPL_TITLE_SGR_ROW));
      await settle(200);
      const verifyBefore = columnOf(stdout, 'verify');
      // `polish` is the neighbour still on screen once the viewport has
      // centred on `verify`, and it is the one that must not budge.
      const polishBefore = columnOf(stdout, 'polish');
      expect(polishBefore).toBeGreaterThan(verifyBefore);

      await dragBy(stdin, grabCol, IMPL_TITLE_SGR_ROW, -6);
      stdin.write(release(grabCol - 6, IMPL_TITLE_SGR_ROW));
      await settle();

      // Six cells of pointer travel, six cells of node travel. Re-centering on
      // the focused box during a drag used to pan the viewport by the same
      // amount the node moved and then fold that pan into the next delta, so
      // the node ran away — and, because the camera ran with it, every other
      // node slid across the screen as if the graph had reordered itself.
      expect(columnOf(stdout, 'verify')).toBe(verifyBefore - 6);
      expect(columnOf(stdout, 'polish')).toBe(polishBefore);
    } finally {
      unmount();
    }
  });

  it('pins a node at the canvas edge, and keeps it under the pointer on the way back', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      const implBefore = columnOf(stdout, 'impl');
      const grabCol = INSIDE_CARD_SGR_COL + 10;

      // `impl` is already hard against x=0, so every cell of this is refused.
      stdin.write(press(grabCol, IMPL_TITLE_SGR_ROW));
      await settle();
      await dragBy(stdin, grabCol, IMPL_TITLE_SGR_ROW, -10);
      await settle();
      expect(columnOf(stdout, 'impl')).toBe(implBefore);

      // Still left of where the drag was grabbed, so the node stays pinned:
      // the delta the handler clamps is also the delta it banks, which keeps
      // the box exactly where the pointer's displacement from the grab point
      // puts it. Accumulating the raw pointer motion instead would have the
      // node crawl out from under the cursor by however much the edge refused.
      await dragBy(stdin, grabCol - 10, IMPL_TITLE_SGR_ROW, 4);
      await settle();
      expect(columnOf(stdout, 'impl')).toBe(implBefore);

      // Past the grab point at last — and by exactly the overshoot, not more.
      await dragBy(stdin, grabCol - 6, IMPL_TITLE_SGR_ROW, 11);
      stdin.write(release(grabCol + 5, IMPL_TITLE_SGR_ROW));
      await settle();
      expect(columnOf(stdout, 'impl')).toBe(implBefore + 5);
    } finally {
      unmount();
    }
  });

  it('does not re-densify the graph when a node is dragged below the canvas', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Implement');

      // Far enough down that the dragged layout is taller than the canvas.
      stdin.write(press(INSIDE_CARD_SGR_COL, IMPL_TITLE_SGR_ROW));
      await settle();
      for (let row = IMPL_TITLE_SGR_ROW + 1; row <= IMPL_TITLE_SGR_ROW + 25; row++) {
        stdin.write(motion(INSIDE_CARD_SGR_COL, row));
        await settle(10);
      }
      stdin.write(release(INSIDE_CARD_SGR_COL, IMPL_TITLE_SGR_ROW + 25));
      await settle();

      // The type-label row exists only on a full card. Auto-compaction used to
      // be measured on the dragged layout, so parking one node low enough
      // collapsed every card in the graph to three rows.
      expect(lastFrameLines(stdout).join('\n')).toContain('Implement');
    } finally {
      unmount();
    }
  });
});

describe('canvas badge clicks', () => {
  it('opens the model picker from the badge row of a full card', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write(press(INSIDE_CARD_SGR_COL, IMPL_BADGE_SGR_ROW));
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Model — impl');
    } finally {
      unmount();
    }
  });

  it('treats the same row on a compact card as the border it is, not a badge', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write('z'); // force compact: border, title, border — and no badge
      await settle();

      stdin.write(press(INSIDE_CARD_SGR_COL, IMPL_BADGE_SGR_ROW));
      await settle();
      // Row 2 is the type-label row on a full card and the bottom border on a
      // compact one. Without a height check this opened a picker from a third
      // of every card the moment the graph auto-compacted.
      expect(lastFrameLines(stdout).join('\n')).not.toContain('Model — impl');
    } finally {
      unmount();
    }
  });

  it('refuses to open a picker underneath a blocking prompt', async () => {
    const { ports, stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      void ports.testCommands.request({
        nodeId: 'rev',
        detected: ['npm test'],
        discover: () => Promise.resolve([]),
      });
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Test commands');

      stdin.write(press(INSIDE_CARD_SGR_COL, IMPL_BADGE_SGR_ROW));
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Test commands');

      // The prompt renders ahead of the picker either way, so the damage is
      // only visible once the prompt is answered: `m` can't reach the picker
      // while a prompt owns the keyboard, but a click used to, leaving one
      // open behind the prompt to spring out here with nothing having asked
      // for it.
      stdin.write('\x1b'); // skip the prompt
      await settle(200);
      expect(lastFrameLines(stdout).join('\n')).not.toContain('Model — impl');
    } finally {
      unmount();
    }
  });

  it('closes a picker when a click moves focus out from under it', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write(press(INSIDE_CARD_SGR_COL, IMPL_BADGE_SGR_ROW));
      await settle();
      expect(lastFrameLines(stdout).join('\n')).toContain('Model — impl');

      const revCol = columnOf(stdout, 'rev');
      expect(revCol).toBeGreaterThan(0);
      stdin.write(press(revCol + 1, IMPL_TITLE_SGR_ROW));
      await settle(300);

      // A panel left open over a node it was not opened for renders one node's
      // state and commits it to another — the pickers all read `focusedNode`.
      const frame = lastFrameLines(stdout).join('\n');
      expect(frame).not.toContain('Model — impl');
      expect(frame).not.toContain('Model — rev');
    } finally {
      unmount();
    }
  });
});

describe('canvas zoom', () => {
  /**
   * Cards are the only thing a terminal can zoom, so the zoom level reads off
   * what a card is made of: a full card has a type-label row, a compact one is
   * border/title/border, a mini one has no border at all.
   */
  function zoomOf(stdout: FakeStdout): 'full' | 'compact' | 'mini' {
    const frame = lastFrameLines(stdout).slice(HEADER_ROWS).join('\n');
    if (!/[╭╰]/.test(frame)) return 'mini';
    return frame.includes('Implement') ? 'full' : 'compact';
  }

  it('steps out and back in on ctrl+wheel, and leaves a plain wheel panning', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      expect(zoomOf(stdout)).toBe('full');

      stdin.write(wheel('down', 10, 3, true));
      await settle();
      expect(zoomOf(stdout)).toBe('compact');

      stdin.write(wheel('down', 10, 3, true));
      await settle();
      expect(zoomOf(stdout)).toBe('mini');

      // Clamped at the coarse end rather than wrapping round to full.
      stdin.write(wheel('down', 10, 3, true));
      await settle();
      expect(zoomOf(stdout)).toBe('mini');

      stdin.write(wheel('up', 10, 3, true));
      stdin.write(wheel('up', 10, 3, true));
      await settle(150);
      expect(zoomOf(stdout)).toBe('full');

      // No ctrl: still a pan, not a zoom.
      stdin.write(wheel('down', 10, 3));
      await settle();
      expect(zoomOf(stdout)).toBe('full');
    } finally {
      unmount();
    }
  });

  it('leaves the chat box alone: ctrl+wheel over an open panel does not zoom', async () => {
    const { ports, stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      void ports.testCommands.request({
        nodeId: 'rev',
        detected: ['npm test'],
        discover: () => Promise.resolve([]),
      });
      await settle();
      expect(zoomOf(stdout)).toBe('full');

      // Row 20 of a 30-row terminal is inside the docked panel.
      stdin.write(wheel('down', 10, 20, true));
      await settle();
      expect(zoomOf(stdout)).toBe('full');
    } finally {
      unmount();
    }
  });

  it('does not change the camera, and the camera does not change the zoom', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      const frame = () => lastFrameLines(stdout).join('\n');
      expect(frame()).not.toContain('free camera');

      // Zooming all the way out used to be the only way to reach the gentler
      // camera, so surveying the graph silently changed how focus behaved.
      stdin.write(wheel('down', 10, 3, true));
      stdin.write(wheel('down', 10, 3, true));
      await settle(150);
      expect(zoomOf(stdout)).toBe('mini');
      expect(frame()).not.toContain('free camera');

      // And the camera toggle is not a disguised zoom.
      stdin.write('c');
      await settle();
      expect(frame()).toContain('free camera');
      expect(zoomOf(stdout)).toBe('mini');

      stdin.write('c');
      await settle();
      expect(frame()).not.toContain('free camera');
    } finally {
      unmount();
    }
  });

  it('o jumps to overview and back to the zoom it left', async () => {
    const { stdout, stdin, unmount } = mountApp();
    try {
      await settle();
      stdin.write(wheel('down', 10, 3, true)); // full → compact
      await settle();
      expect(zoomOf(stdout)).toBe('compact');

      stdin.write('o');
      await settle();
      expect(zoomOf(stdout)).toBe('mini');

      stdin.write('o');
      await settle(150);
      expect(zoomOf(stdout)).toBe('compact');
    } finally {
      unmount();
    }
  });
});
