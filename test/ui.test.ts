import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridToLines, nodeModelBadge, nodeSkillBadge, renderGraph, STATUS_GLYPHS } from '../src/ui/canvas.js';
import { defaultSkillRoots } from '../src/skills/discover.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import {
  centerOnBox,
  clampOffset,
  COMPACT_BOX_HEIGHT,
  computeLayout,
  FOCUS_ANCHOR_X_FRACTION,
  FOCUS_ANCHOR_Y_ROWS,
  hitTest,
  MAX_BOX_CONTENT,
  MINI_BOX_HEIGHT,
  MINI_MAX_BOX_CONTENT,
  MINI_MIN_BOX_CONTENT,
  offscreenCounts,
  rowPitch,
  scrollIntoView,
  ZOOM_DENSITIES,
} from '../src/ui/layout.js';
import { LEAKED_MOUSE_SEQUENCE, parseMouseEvents } from '../src/ui/mouse.js';
import {
  applyPanelMove,
  applyPanelResize,
  dockedLayout,
  dockedRect,
  hitTestPanel,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  pinAfterScroll,
  tailWindow,
} from '../src/ui/panel.js';
import { RunInterruptedError } from '../src/engine/types.js';
import { getNodeType } from '../src/registry/index.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
import { wrapText } from '../src/ui/textwrap.js';
import { storeFor, workflowFromYaml } from './helpers.js';

const WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: test
    config: { commands: ["true"] }
  - id: rev
    type: review
edges:
  - { from: impl, to: check }
  - { from: impl, to: rev }
`);

function load(yaml: string, skills: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'flow-code-ui-skills-'));
  const repoRoot = join(base, 'repo');
  const roots = defaultSkillRoots(repoRoot, join(base, 'home'));
  for (const [name, body] of Object.entries(skills)) {
    const dir = join(roots.project, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
  }
  return loadWorkflowFromString(yaml, { repoRoot, skillRoots: roots });
}

describe('graph auto-layout', () => {
  it('places every node after all of its dependencies, left to right', () => {
    const layout = computeLayout(WF);
    const impl = layout.boxes.get('impl')!;
    const check = layout.boxes.get('check')!;
    const rev = layout.boxes.get('rev')!;
    expect(impl.layer).toBe(0);
    expect(check.layer).toBe(1);
    expect(rev.layer).toBe(1);
    expect(check.x).toBeGreaterThan(impl.x + impl.w);
    expect(rev.x).toBeGreaterThan(impl.x + impl.w);
    // Same layer stacks vertically without overlap.
    expect(check.y !== rev.y).toBe(true);
  });

  it('applies session-only drag overrides without mutating base layout', () => {
    const base = computeLayout(WF);
    const overrides = new Map([
      ['impl', { dxFrac: 10 / base.baseWidth, dyRows: 3 / rowPitch('full') }],
    ]);
    const overridden = computeLayout(WF, overrides);
    expect(overridden.boxes.get('impl')!.x).toBe(base.boxes.get('impl')!.x + 10);
    expect(overridden.boxes.get('impl')!.y).toBe(base.boxes.get('impl')!.y + 3);
    expect(computeLayout(WF).boxes.get('impl')!.x).toBe(base.boxes.get('impl')!.x);
  });

  it('replays a drag at every zoom in its own units, so an arrangement survives zooming', () => {
    // One card pitch down and a fifth of the graph across — the arrangement
    // ctrl+wheel, `z` and `o` all have to preserve.
    const overrides = new Map([['impl', { dxFrac: 0.2, dyRows: 1 }]]);
    for (const density of ZOOM_DENSITIES) {
      const base = computeLayout(WF, undefined, { density });
      const moved = computeLayout(WF, overrides, { density });
      const box = moved.boxes.get('impl')!;
      const from = base.boxes.get('impl')!;
      expect(box.y - from.y).toBe(rowPitch(density));
      // Scaled to that zoom's own graph width, not replayed as raw cells:
      // mini's columns are roughly half as wide as a full card's.
      expect(box.x - from.x).toBe(Math.round(0.2 * base.baseWidth));
    }
  });

  it('reports baseWidth from the un-dragged graph, so one drag cannot rescale another', () => {
    const base = computeLayout(WF);
    // Far enough right to push the graph's own right edge out past where the
    // auto-layout put it.
    const dragged = computeLayout(WF, new Map([['impl', { dxFrac: 2, dyRows: 0 }]]));
    expect(dragged.width).toBeGreaterThan(base.width);
    expect(dragged.baseWidth).toBe(base.baseWidth);
  });

  it('scrollIntoView brings an out-of-viewport box into view', () => {
    const layout = computeLayout(WF);
    const rev = layout.boxes.get('rev')!;
    // The viewport has to be at least one box big for "fully visible" to be
    // achievable at all — a node card is 24×6.
    const { ox, oy } = scrollIntoView(rev, { ox: 0, oy: 0, width: 30, height: 8 });
    expect(ox).toBeGreaterThan(0);
    expect(rev.x).toBeGreaterThanOrEqual(ox);
    expect(rev.x + rev.w).toBeLessThanOrEqual(ox + 30);
    expect(rev.y + rev.h).toBeLessThanOrEqual(oy + 8);
  });

  it('widens a box to fit the summary it will draw, up to a ceiling', () => {
    const wf = workflowFromYaml(`
nodes:
  - id: spec
    type: spec
    config:
      acceptanceCriteria: ["a", "b", "c"]
  - id: verbose
    type: implement
    config:
      instructions: ${'x'.repeat(200)}
`);
    const layout = computeLayout(wf);
    // "3 acceptance criteria (given)" used to be cut to "3 acceptance criteri".
    const spec = layout.boxes.get('spec')!;
    expect(spec.w - 2).toBeGreaterThanOrEqual('3 acceptance criteria (given)'.length + 1);
    // One long-winded node can't stretch its layer off the screen.
    expect(layout.boxes.get('verbose')!.w - 2).toBe(MAX_BOX_CONTENT);
  });

  it('compact layout keeps the columns and shortens every card', () => {
    const full = computeLayout(WF);
    const compact = computeLayout(WF, undefined, { density: 'compact' });
    expect(compact.boxes.get('impl')!.h).toBe(COMPACT_BOX_HEIGHT);
    expect(compact.height).toBeLessThan(full.height);
    // Widths and columns are unchanged — only the vertical footprint shrinks.
    expect(compact.width).toBe(full.width);
    expect(compact.boxes.get('rev')!.x).toBe(full.boxes.get('rev')!.x);
  });

  it('mini layout shrinks both height and width, unlike compact which only shrinks height', () => {
    const compact = computeLayout(WF, undefined, { density: 'compact' });
    const mini = computeLayout(WF, undefined, { density: 'mini' });
    expect(mini.boxes.get('impl')!.h).toBe(MINI_BOX_HEIGHT);
    expect(mini.boxes.get('impl')!.w).toBeLessThan(compact.boxes.get('impl')!.w);
    expect(mini.height).toBeLessThan(compact.height);
  });

  it('clamps mini box width to its own (narrower) bounds', () => {
    const shortId = workflowFromYaml(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
`);
    const longId = workflowFromYaml(`
nodes:
  - id: ${'x'.repeat(50)}
    type: implement
    config: { instructions: x }
`);
    const shortMini = computeLayout(shortId, undefined, { density: 'mini' });
    const longMini = computeLayout(longId, undefined, { density: 'mini' });
    for (const layout of [shortMini, longMini]) {
      for (const box of layout.boxes.values()) {
        expect(box.w).toBeGreaterThanOrEqual(MINI_MIN_BOX_CONTENT);
        expect(box.w).toBeLessThanOrEqual(MINI_MAX_BOX_CONTENT);
      }
    }
  });

  it('centerOnBox anchors the box left-of-center and near the top, unclamped', () => {
    const layout = computeLayout(WF);
    const rev = layout.boxes.get('rev')!;
    const viewport = { width: 40, height: 20 };
    const { ox, oy } = centerOnBox(rev, viewport);
    expect(ox).toBe(rev.x - Math.round(viewport.width * FOCUS_ANCHOR_X_FRACTION));
    expect(oy).toBe(rev.y - FOCUS_ANCHOR_Y_ROWS);
    // Near the origin the raw result goes negative — clamping is the caller's job.
    const impl = layout.boxes.get('impl')!;
    expect(centerOnBox(impl, viewport).oy).toBeLessThan(0);
  });

  it('clampOffset stops panning at the far edge of the graph', () => {
    const layout = computeLayout(WF);
    const viewport = { width: 30, height: 8 };
    const far = clampOffset(layout, { ox: 9999, oy: 9999, ...viewport });
    expect(far.ox).toBe(layout.width - 30);
    expect(far.oy).toBe(layout.height - 8);
    expect(clampOffset(layout, { ox: -5, oy: -5, ...viewport })).toEqual({ ox: 0, oy: 0 });
  });

  it('clampOffset pins a graph smaller than its viewport to the origin', () => {
    const layout = computeLayout(WF);
    expect(clampOffset(layout, { ox: 20, oy: 20, width: 500, height: 200 })).toEqual({
      ox: 0,
      oy: 0,
    });
  });

  it('offscreenCounts counts the nodes outside the viewport per direction', () => {
    const layout = computeLayout(WF);
    // Narrow enough to hold only the first layer: impl is visible, the two
    // nodes that depend on it are off to the right.
    const narrow = offscreenCounts(layout, { ox: 0, oy: 0, width: 26, height: 50 });
    expect(narrow.right).toBe(2);
    expect(narrow.left).toBe(0);

    // Short enough to hold only the top row of the second layer.
    const short = offscreenCounts(layout, { ox: 0, oy: 0, width: 500, height: 6 });
    expect(short.down).toBe(1);
    expect(short.up).toBe(0);

    expect(offscreenCounts(layout, { ox: 0, oy: 0, width: 500, height: 200 })).toEqual({
      left: 0,
      right: 0,
      up: 0,
      down: 0,
    });
  });

  it('hitTest maps canvas coordinates to node ids', () => {
    const layout = computeLayout(WF);
    const impl = layout.boxes.get('impl')!;
    expect(hitTest(layout, impl.x + 1, impl.y + 1)).toBe('impl');
    expect(hitTest(layout, impl.x + impl.w + 3, impl.y)).toBeNull();
  });

  it('hitTest picks the card drawn on top where two overlap, not the first laid out', () => {
    // Drag `rev` back over `impl`. renderGraph paints in workflow.nodes order,
    // so `rev` — later in that order — is the one actually visible here.
    const base = computeLayout(WF);
    const rev = base.boxes.get('rev')!;
    const impl = base.boxes.get('impl')!;
    const layout = computeLayout(
      WF,
      new Map([['rev', { dxFrac: (impl.x - rev.x) / base.baseWidth, dyRows: -rev.y / rowPitch('full') }]]),
    );
    expect(layout.boxes.get('rev')).toEqual(expect.objectContaining({ x: impl.x, y: impl.y }));

    const drawOrder = WF.nodes.map((n) => n.id);
    expect(drawOrder.indexOf('rev')).toBeGreaterThan(drawOrder.indexOf('impl'));
    // Without the draw order this returns 'impl' — the card underneath, which
    // is why a node dropped on top of another could not be picked up again.
    expect(hitTest(layout, impl.x + 1, impl.y + 1, drawOrder)).toBe('rev');
  });
});

describe('canvas rendering', () => {
  it('renders each status with its own glyph, skipped distinct from idle', () => {
    const store = storeFor(WF, '/tmp');
    store.setStatus('impl', 'done');
    store.setStatus('check', 'skipped');
    const layout = computeLayout(WF);
    const grid = renderGraph(WF, layout, store.snapshot(), null);
    const text = gridToLines(grid, { ox: 0, oy: 0, width: layout.width + 2, height: layout.height + 1 })
      .join('\n')
      // strip ANSI for content assertions
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain(`${STATUS_GLYPHS.done} impl`);
    expect(text).toContain(`${STATUS_GLYPHS.skipped} check`);
    expect(text).toContain(`${STATUS_GLYPHS.idle} rev`);
    expect(STATUS_GLYPHS.skipped).not.toBe(STATUS_GLYPHS.idle);
    // Edges drawn between boxes.
    expect(text).toContain('▶');
  });

  it('draws a live card: spinner, current tool call, tokens and elapsed time', () => {
    const store = storeFor(WF, '/tmp');
    store.setStatus('impl', 'running');
    store.addTokens('impl', { input: 1_200, output: 340, cached: 0 });
    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'impl',
      tool: 'Edit',
      summary: 'src/ui/canvas.ts',
      decision: 'allowed',
    });
    const layout = computeLayout(WF);
    const started = Date.parse(store.snapshot().nodes['impl']!.startedAt!);
    const render = (frame: number): string =>
      gridToLines(renderGraph(WF, layout, store.snapshot(), null, { frame, now: started + 5_000 }), {
        ox: 0,
        oy: 0,
        width: layout.width + 2,
        height: layout.height + 1,
      })
        .join('\n')
        .replace(/\x1b\[[0-9;]*m/g, '');

    const frame0 = render(0);
    expect(frame0).toContain('Edit src/ui/canvas.ts');
    expect(frame0).toContain('↑1.2k ↓340 · 5s');
    // The status glyph animates while running, so a working node is visibly
    // distinct from a stalled one.
    expect(render(1).split('impl')[0]).not.toBe(frame0.split('impl')[0]);
  });

  it('fills the subtitle with what a node will do, and later with what it produced', () => {
    const store = storeFor(WF, '/tmp');
    const layout = computeLayout(WF);
    const text = (): string =>
      gridToLines(renderGraph(WF, layout, store.snapshot(), null), {
        ox: 0,
        oy: 0,
        width: layout.width + 2,
        height: layout.height + 1,
      })
        .join('\n')
        .replace(/\x1b\[[0-9;]*m/g, '');

    // Idle: the configured intent, not the type name repeated back.
    expect(text()).toContain('true');
    expect(text()).not.toContain('Implement Implement');

    store.setStatus('impl', 'done');
    store.setOutput('impl', { changedFiles: ['a.ts', 'b.ts'], diff: '' });
    expect(text()).toContain('2 files changed');
  });

  it('draws a compact card as title plus metrics, with no rows past the border', () => {
    const store = storeFor(WF, '/tmp');
    store.setStatus('impl', 'running');
    store.addTokens('impl', { input: 1_200, output: 340, cached: 0 });
    const layout = computeLayout(WF, undefined, { density: 'compact' });
    const started = Date.parse(store.snapshot().nodes['impl']!.startedAt!);
    const lines = gridToLines(
      renderGraph(WF, layout, store.snapshot(), null, { frame: 0, now: started + 5_000 }),
      { ox: 0, oy: 0, width: layout.width + 2, height: layout.height + 1 },
    ).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const text = lines.join('\n');

    expect(text).toContain('impl');
    // Tokens move onto the title row, since the metrics row is gone — the
    // clock is dropped rather than eliding both into uselessness.
    expect(lines.find((l) => l.includes('impl'))).toContain('↑1.2k ↓340');
    // The type name and subtitle rows aren't drawn at all.
    expect(text).not.toContain('Implement');
    // Three rows per card, and every one of them closed by a border.
    expect(layout.boxes.get('impl')!.h).toBe(3);
    expect(lines[2]!.startsWith('╰')).toBe(true);
  });

  it('draws a mini card as one borderless row, with edges connecting to that row', () => {
    const store = storeFor(WF, '/tmp');
    const layout = computeLayout(WF, undefined, { density: 'mini' });
    const grid = renderGraph(WF, layout, store.snapshot(), null);
    const lines = gridToLines(grid, {
      ox: 0,
      oy: 0,
      width: layout.width + 2,
      height: layout.height + 1,
    }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const text = lines.join('\n');

    expect(layout.boxes.get('impl')!.h).toBe(MINI_BOX_HEIGHT);
    expect(text).toContain('impl');
    // No border glyphs within any mini box's own columns (edges elsewhere in
    // the grid legitimately use '│' for vertical connectors between layers).
    for (const box of layout.boxes.values()) {
      const row = lines[box.y]!.slice(box.x, box.x + box.w);
      expect(row).not.toMatch(/[╭╰│]/);
    }

    // The edge out of impl connects on its one and only row, not the row below it,
    // and arrives on the target's one and only row too.
    const impl = layout.boxes.get('impl')!;
    const check = layout.boxes.get('check')!;
    expect(lines[impl.y]).toContain('─');
    expect(lines[check.y]).toContain('▶');
  });

  it('marks an elided card line with an ellipsis rather than cutting it dead', () => {
    const store = storeFor(WF, '/tmp');
    store.setStatus('impl', 'error', 'node token budget exhausted: 12000 tokens spent of 10000 allowed');
    const layout = computeLayout(WF);
    const text = gridToLines(renderGraph(WF, layout, store.snapshot(), null), {
      ox: 0,
      oy: 0,
      width: layout.width + 2,
      height: layout.height + 1,
    })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('node token budget ex…');
  });

  it('shows a blocked-action indicator on nodes with denials', () => {
    const store = storeFor(WF, '/tmp');
    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId: 'impl',
      tool: 'Bash',
      summary: 'git push',
      decision: 'denied',
      missingCapability: 'git-write',
    });
    const layout = computeLayout(WF);
    const grid = renderGraph(WF, layout, store.snapshot(), null);
    const text = gridToLines(grid, { ox: 0, oy: 0, width: layout.width + 2, height: layout.height + 1 })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('impl !');
  });
});

describe('nodeModelBadge / model badge rendering', () => {
  const MODEL_WF = workflowFromYaml(`
settings:
  model: sonnet
nodes:
  - id: impl
    type: implement
    config: { instructions: x, model: opus }
  - id: rev
    type: review
  - id: check
    type: test
    config: { commands: ["true"] }
edges:
  - { from: impl, to: rev }
  - { from: impl, to: check }
`);

  it('badges a node whose resolved model differs from settings.model', () => {
    expect(nodeModelBadge(MODEL_WF, 'impl')).toBe('opus');
  });

  it('carries no badge for a node that resolves to the run-wide default', () => {
    expect(nodeModelBadge(MODEL_WF, 'rev')).toBeNull();
  });

  it('carries no badge for a node type with no model field', () => {
    expect(nodeModelBadge(MODEL_WF, 'check')).toBeNull();
  });

  it('returns null for an unknown node id', () => {
    expect(nodeModelBadge(MODEL_WF, 'nope')).toBeNull();
  });

  it('draws the badge on the box, and prefers the retry badge over it on collision', () => {
    const store = storeFor(MODEL_WF, '/tmp');
    const layout = computeLayout(MODEL_WF);

    const before = gridToLines(renderGraph(MODEL_WF, layout, store.snapshot(), null), {
      ox: 0,
      oy: 0,
      width: layout.width + 2,
      height: layout.height + 1,
    })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(before).toContain('opus');
    expect(before).not.toContain('↻');

    // A loop-back re-run bumps attempt > 1 — the retry badge then takes the
    // same corner cell the model badge was drawn in, and wins.
    store.resetNode('impl');
    const after = gridToLines(renderGraph(MODEL_WF, layout, store.snapshot(), null), {
      ox: 0,
      oy: 0,
      width: layout.width + 2,
      height: layout.height + 1,
    })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(after).toContain('↻2');
    expect(after).not.toContain('opus');
  });
});

describe('nodeSkillBadge / skill badge rendering', () => {
  it('badges a node with one attached skill by name, several by count', () => {
    const wf = load(
      `
nodes:
  - id: impl
    type: implement
    config: { instructions: x, skills: [my-skill] }
  - id: rev
    type: review
    config: { skills: [one, two] }
  - id: check
    type: test
    config: { commands: ["true"] }
edges:
  - { from: impl, to: rev }
  - { from: impl, to: check }
`,
      { 'my-skill': 'body', one: 'body', two: 'body' },
    );

    expect(nodeSkillBadge(wf, 'impl')).toBe('»my-skill');
    expect(nodeSkillBadge(wf, 'rev')).toBe('»×2');
    expect(nodeSkillBadge(wf, 'check')).toBeNull();
    expect(nodeSkillBadge(wf, 'nope')).toBeNull();
  });

  it('draws the skill badge on the box, and yields the corner to the model badge on collision', () => {
    const wf = load(
      `
settings:
  model: sonnet
nodes:
  - id: impl
    type: implement
    config: { instructions: x, model: opus, skills: [my-skill] }
edges: []
`,
      { 'my-skill': 'body' },
    );
    const store = storeFor(wf, '/tmp');
    const layout = computeLayout(wf);
    const text = gridToLines(renderGraph(wf, layout, store.snapshot(), null), {
      ox: 0,
      oy: 0,
      width: layout.width + 2,
      height: layout.height + 1,
    })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('opus');
    expect(text).not.toContain('»');
  });

  it('draws the skill badge when there is no model override to collide with', () => {
    const wf = load(
      `
nodes:
  - id: impl
    type: implement
    config: { instructions: x, skills: [my-skill] }
edges: []
`,
      { 'my-skill': 'body' },
    );
    const store = storeFor(wf, '/tmp');
    const layout = computeLayout(wf);
    const text = gridToLines(renderGraph(wf, layout, store.snapshot(), null), {
      ox: 0,
      oy: 0,
      width: layout.width + 2,
      height: layout.height + 1,
    })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('»my-skill');
  });
});

describe('node type registry: hasModelField', () => {
  it('is true only for agent-driven types with a single, top-level model field', () => {
    expect(getNodeType('discuss')?.hasModelField).toBe(true);
    expect(getNodeType('implement')?.hasModelField).toBe(true);
    expect(getNodeType('validate')?.hasModelField).toBe(true);
    expect(getNodeType('review')?.hasModelField).toBe(true);
    expect(getNodeType('git-ops')?.hasModelField).toBe(true);
  });

  it('is false for types with no agent session, and for worktree-agent (per-instance model, not one field)', () => {
    expect(getNodeType('test')?.hasModelField).toBe(false);
    expect(getNodeType('approval-gate')?.hasModelField).toBe(false);
    expect(getNodeType('worktree-agent')?.hasModelField).toBe(false);
  });
});

const LOOP_WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
edges:
  - { from: impl, to: check }
  - { from: check, to: impl, loopback: true }
`);

const FORWARD_WF = workflowFromYaml(`
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
  - id: check
    type: validate
edges:
  - { from: impl, to: check }
`);

function renderText(wf: typeof LOOP_WF, state: ReturnType<typeof storeFor>): string {
  const layout = computeLayout(wf);
  const grid = renderGraph(wf, layout, state.snapshot(), null);
  return gridToLines(grid, {
    ox: 0,
    oy: 0,
    width: layout.width + 2,
    height: grid.length,
  })
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
}

describe('loop-back rendering', () => {
  it('lays out identically with and without a loop-back', () => {
    const looped = computeLayout(LOOP_WF);
    const forward = computeLayout(FORWARD_WF);
    for (const id of ['impl', 'check']) {
      expect(looped.boxes.get(id)!.x).toBe(forward.boxes.get(id)!.x);
      expect(looped.boxes.get(id)!.y).toBe(forward.boxes.get(id)!.y);
      expect(looped.boxes.get(id)!.layer).toBe(forward.boxes.get(id)!.layer);
    }
  });

  it('draws the return path distinctly from forward edges', () => {
    const store = storeFor(LOOP_WF, '/tmp');
    const text = renderText(LOOP_WF, store);
    // Forward edges use ─ ▶; the return path uses a dashed run and ▲.
    expect(text).toContain('▶');
    expect(text).toContain('╌');
    expect(text).toContain('▲');
    expect(renderText(FORWARD_WF, storeFor(FORWARD_WF, '/tmp'))).not.toContain('╌');
  });

  it('uses a distinct style for the return path', () => {
    const store = storeFor(LOOP_WF, '/tmp');
    const layout = computeLayout(LOOP_WF);
    const grid = renderGraph(LOOP_WF, layout, store.snapshot(), null);
    const styles = new Set(grid.flat().map((c) => c.style));
    expect(styles.has('loopback')).toBe(true);
  });

  it('shows no attempt badge on a first attempt', () => {
    const store = storeFor(LOOP_WF, '/tmp');
    store.setStatus('impl', 'done');
    expect(renderText(LOOP_WF, store)).not.toContain('↻');
  });

  it('badges a re-run node and marks the loop that fired', () => {
    const store = storeFor(LOOP_WF, '/tmp');
    store.setStatus('check', 'error', 'Validate verdict: fail');
    store.resetNode('check');
    store.resetNode('impl');
    const text = renderText(LOOP_WF, store);
    expect(text).toContain('↻2');
    expect(text).toContain('retry from check');
  });

  it('renders reset nodes as idle again', () => {
    const store = storeFor(LOOP_WF, '/tmp');
    store.setStatus('impl', 'done');
    store.resetNode('impl');
    expect(renderText(LOOP_WF, store)).toContain(`${STATUS_GLYPHS.idle} impl`);
  });
});

describe('mouse parsing (SGR)', () => {
  it('parses press, drag, and release with 0-based coordinates', () => {
    expect(parseMouseEvents('\x1b[<0;5;3M')).toEqual([
      { kind: 'press', x: 4, y: 2, button: 0, ctrl: false },
    ]);
    expect(parseMouseEvents('\x1b[<32;6;3M')).toEqual([
      { kind: 'drag', x: 5, y: 2, button: 0, ctrl: false },
    ]);
    expect(parseMouseEvents('\x1b[<0;6;3m')).toEqual([
      { kind: 'release', x: 5, y: 2, button: 0, ctrl: false },
    ]);
  });

  it('ignores non-mouse input entirely (graceful no-mouse fallback)', () => {
    expect(parseMouseEvents('hello\x1b[Aworld')).toEqual([]);
  });

  it('parses wheel up/down as scroll events, not clicks', () => {
    expect(parseMouseEvents('\x1b[<64;5;3M')).toEqual([
      { kind: 'scroll', x: 4, y: 2, button: 0, ctrl: false, direction: 'up' },
    ]);
    expect(parseMouseEvents('\x1b[<65;5;3M')).toEqual([
      { kind: 'scroll', x: 4, y: 2, button: 1, ctrl: false, direction: 'down' },
    ]);
  });

  it('separates ctrl+wheel from a plain wheel, so zoom and pan stay distinct', () => {
    // The terminal ORs modifier bits into the button code; masking them off
    // made ctrl+wheel indistinguishable from a bare wheel, so a zoom gesture
    // silently panned instead.
    expect(parseMouseEvents('\x1b[<80;5;3M')).toEqual([
      { kind: 'scroll', x: 4, y: 2, button: 0, ctrl: true, direction: 'up' },
    ]);
    expect(parseMouseEvents('\x1b[<81;5;3M')).toEqual([
      { kind: 'scroll', x: 4, y: 2, button: 1, ctrl: true, direction: 'down' },
    ]);
    // Shift is a modifier too, and must not read as ctrl.
    expect(parseMouseEvents('\x1b[<68;5;3M')).toEqual([
      { kind: 'scroll', x: 4, y: 2, button: 0, ctrl: false, direction: 'up' },
    ]);
  });

  it('recognizes the bare sequence ink hands back after stripping ESC', () => {
    expect(LEAKED_MOUSE_SEQUENCE.test('[<0;5;3M')).toBe(true);
    expect(LEAKED_MOUSE_SEQUENCE.test('[<64;5;3M')).toBe(true);
    expect(LEAKED_MOUSE_SEQUENCE.test('hello')).toBe(false);
  });
});

describe('panel geometry (docked/floating status panel)', () => {
  const bounds = { columns: 100, rows: 40 };

  it('docks full-width, pinned to the bottom, at the given height', () => {
    const rect = dockedRect(bounds, 15);
    expect(rect).toEqual({ x: 0, y: 25, w: 100, h: 15 });
  });

  it('clamps docked height to the terminal, never taller than it', () => {
    expect(dockedRect(bounds, 999)).toEqual({ x: 0, y: 0, w: 100, h: 40 });
  });

  it('hitTestPanel recognizes the border edges and the title row as "move"', () => {
    const rect = { x: 10, y: 10, w: 20, h: 10 };
    expect(hitTestPanel(rect, 10, 15)).toBe('move'); // left edge
    expect(hitTestPanel(rect, 29, 15)).toBe('move'); // right edge
    expect(hitTestPanel(rect, 15, 10)).toBe('move'); // top edge
    expect(hitTestPanel(rect, 15, 19)).toBe('move'); // bottom edge (not the corner)
    expect(hitTestPanel(rect, 15, 11)).toBe('move'); // title row, just inside the top border
  });

  it('hitTestPanel gives the bottom-right grip a grabbable block, not one cell', () => {
    const rect = { x: 10, y: 10, w: 20, h: 10 };
    expect(hitTestPanel(rect, 29, 19)).toBe('resize'); // corner
    expect(hitTestPanel(rect, 27, 18)).toBe('resize'); // the grip glyph's cell
    expect(hitTestPanel(rect, 26, 18)).toBeNull(); // just left of the block: still content
  });

  it('hitTestPanel returns null for the interior and outside the rect', () => {
    const rect = { x: 10, y: 10, w: 20, h: 10 };
    expect(hitTestPanel(rect, 15, 15)).toBeNull();
    expect(hitTestPanel(rect, 5, 5)).toBeNull();
    expect(hitTestPanel(rect, 100, 100)).toBeNull();
  });

  it('dockedLayout leaves the canvas exactly the rows above the panel', () => {
    // The drawn panel must land on the rect the mouse is hit-tested against;
    // any slack between canvas and panel makes every border drag miss.
    const { rect, canvasHeight } = dockedLayout(bounds, 1);
    expect(canvasHeight).toBe(rect.y - 1);
    expect(rect.y + rect.h).toBe(bounds.rows);
  });

  it('dockedLayout always leaves at least one canvas row on a short terminal', () => {
    const { rect, canvasHeight } = dockedLayout({ columns: 80, rows: 6 }, 1);
    expect(canvasHeight).toBe(1);
    expect(rect.y).toBe(2);
    expect(rect.h).toBe(4);
  });

  it('applyPanelMove translates the rect and clamps to the screen', () => {
    const rect = { x: 10, y: 10, w: 20, h: 10 };
    expect(applyPanelMove(rect, 5, -3, bounds)).toEqual({ x: 15, y: 7, w: 20, h: 10 });
    // Dragged past the right/bottom edge — clamped so it stays fully on screen.
    expect(applyPanelMove(rect, 1000, 1000, bounds)).toEqual({ x: 80, y: 30, w: 20, h: 10 });
    // Dragged past the top-left — clamped at 0.
    expect(applyPanelMove(rect, -1000, -1000, bounds)).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  it('applyPanelResize grows/shrinks from the bottom-right corner, with a floor', () => {
    const rect = { x: 10, y: 10, w: 20, h: 10 };
    expect(applyPanelResize(rect, 5, 5, bounds)).toEqual({ x: 10, y: 10, w: 25, h: 15 });
    expect(applyPanelResize(rect, -1000, -1000, bounds)).toEqual({
      x: 10,
      y: 10,
      w: MIN_PANEL_WIDTH,
      h: MIN_PANEL_HEIGHT,
    });
  });

  it('applyPanelResize never grows past the screen edge', () => {
    const rect = { x: 70, y: 30, w: MIN_PANEL_WIDTH, h: MIN_PANEL_HEIGHT };
    const resized = applyPanelResize(rect, 1000, 1000, bounds);
    expect(resized.x + resized.w).toBeLessThanOrEqual(bounds.columns);
    expect(resized.y + resized.h).toBeLessThanOrEqual(bounds.rows);
  });
});

describe('tailWindow (chat-style scrollback)', () => {
  it('follows the live tail when pin is null', () => {
    expect(tailWindow(50, 10, null)).toEqual({ start: 40, end: 50, maxScroll: 40, following: true });
  });

  it('pins the window at an absolute row, not following', () => {
    expect(tailWindow(50, 10, 20)).toEqual({ start: 20, end: 30, maxScroll: 40, following: false });
  });

  it('clamps a pin below 0 or past the live bottom', () => {
    expect(tailWindow(50, 10, -5).start).toBe(0);
    expect(tailWindow(50, 10, 1000)).toEqual({ start: 40, end: 50, maxScroll: 40, following: true });
  });

  it('is a no-op window when everything already fits', () => {
    expect(tailWindow(5, 10, 3)).toEqual({ start: 0, end: 10, maxScroll: 0, following: true });
  });

  it('holds a fixed historical slice steady as new messages extend the total', () => {
    // A user pins to row 5 out of a 20-row transcript...
    const before = tailWindow(20, 10, 5);
    // ...5 more messages arrive; since the pin is an absolute row index, the
    // same historical rows stay put instead of drifting with the moving tail.
    const after = tailWindow(25, 10, 5);
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);
    expect(after.following).toBe(false);
  });

  it('pinAfterScroll converts a scroll-up gesture into a pin behind the live tail', () => {
    const win = tailWindow(50, 10, null); // following, start=40
    const pin = pinAfterScroll(win, 5); // scroll up 5 rows
    expect(pin).toBe(35);
    expect(tailWindow(50, 10, pin).following).toBe(false);
  });

  it('pinAfterScroll snaps back to following once scrolled down to the bottom', () => {
    const win = tailWindow(50, 10, 30); // pinned, 10 rows above the live bottom (maxScroll 40)
    expect(pinAfterScroll(win, -5)).toBe(35); // scroll down, still short of the bottom
    expect(pinAfterScroll(win, -10)).toBeNull(); // scroll down past the bottom -> resume following
  });
});

describe('wrapText', () => {
  it('greedily wraps words to the given width', () => {
    expect(wrapText('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('preserves existing newlines as paragraph breaks', () => {
    expect(wrapText('line one\nline two', 20)).toEqual(['line one', 'line two']);
  });

  it('preserves blank lines', () => {
    expect(wrapText('a\n\nb', 20)).toEqual(['a', '', 'b']);
  });

  it('hard-breaks a single token longer than the width', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('does not truncate long multi-paragraph text, unlike a first-line-only view', () => {
    const text = 'This is the full first line of a long agent reply.\nAnd a second paragraph follows.';
    const wrapped = wrapText(text, 20);
    expect(wrapped.length).toBeGreaterThan(2);
    expect(wrapped.join(' ')).toContain('second paragraph');
  });
});

describe('UI interaction ports', () => {
  it('resolves an approval request when the UI decides', async () => {
    const ports = new UiInteractionPorts();
    const decision = ports.approval.request({
      nodeId: 'gate',
      title: 't',
      diffs: [{ diff: '' }],
      upstreamSummaries: [],
    });
    expect(ports.pendingApproval).not.toBeNull();
    ports.pendingApproval!.resolve('reject');
    await expect(decision).resolves.toBe('reject');
    expect(ports.pendingApproval).toBeNull();
  });

  it('runs a discussion round-trip through the port', async () => {
    const ports = new UiInteractionPorts();
    ports.discuss.begin('talk', 'topic');
    ports.discuss.postAssistant('talk', 'hello, what do you want?');
    const next = ports.discuss.nextUserMessage('talk');
    expect(ports.discussState!.awaitingUser).toBe(true);
    ports.submitUserMessage('make it blue');
    await expect(next).resolves.toBe('make it blue');
    const done = ports.discuss.nextUserMessage('talk');
    ports.submitUserMessage(null);
    await expect(done).resolves.toBeNull();
    ports.discuss.end('talk');
    expect(ports.discussState!.active).toBe(false);
    expect(ports.discussState!.transcript.map((t) => t.role)).toEqual(['assistant', 'user']);
  });

  it('replaces discussState on every change so React sees new messages', async () => {
    // Regression: the transcript was pushed to in place, so the App's memo
    // kept rendering the state it first saw — messages stopped appearing.
    const ports = new UiInteractionPorts();
    ports.discuss.begin('talk', 'topic');
    const seen = [ports.discussState];
    ports.discuss.postAssistant('talk', 'hi');
    seen.push(ports.discussState);
    const next = ports.discuss.nextUserMessage('talk');
    seen.push(ports.discussState);
    ports.submitUserMessage('there');
    seen.push(ports.discussState);
    await next;
    ports.discuss.end('talk');
    seen.push(ports.discussState);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen.map((s) => s!.transcript)).size).toBe(3); // begin, +assistant, +user
  });

  it('rejects a pending approval when the run is interrupted', async () => {
    const controller = new AbortController();
    const ports = new UiInteractionPorts(controller.signal);
    const decision = ports.approval.request({
      nodeId: 'gate',
      title: 't',
      diffs: [{ diff: '' }],
      upstreamSummaries: [],
    });
    expect(ports.pendingApproval).not.toBeNull();
    controller.abort();
    await expect(decision).rejects.toBeInstanceOf(RunInterruptedError);
    expect(ports.pendingApproval).toBeNull();
  });

  it('rejects a pending convergence selection when the run is interrupted', async () => {
    const controller = new AbortController();
    const ports = new UiInteractionPorts(controller.signal);
    const decision = ports.convergence.select({
      nodeId: 'wt',
      mode: 'compare',
      branches: [],
    });
    controller.abort();
    await expect(decision).rejects.toBeInstanceOf(RunInterruptedError);
    expect(ports.pendingConvergence).toBeNull();
  });

  it('rejects a pending discussion wait when the run is interrupted', async () => {
    const controller = new AbortController();
    const ports = new UiInteractionPorts(controller.signal);
    ports.discuss.begin('talk', undefined);
    const next = ports.discuss.nextUserMessage('talk');
    expect(ports.discussState!.awaitingUser).toBe(true);
    controller.abort();
    await expect(next).rejects.toBeInstanceOf(RunInterruptedError);
    // A late/stray submit after interrupt is a harmless no-op.
    expect(() => ports.submitUserMessage('too late')).not.toThrow();
  });

  it('rejects immediately if the run is already interrupted before the wait begins', async () => {
    const controller = new AbortController();
    controller.abort();
    const ports = new UiInteractionPorts(controller.signal);
    await expect(
      ports.approval.request({ nodeId: 'gate', title: 't', diffs: [], upstreamSummaries: [] }),
    ).rejects.toBeInstanceOf(RunInterruptedError);
  });
});
