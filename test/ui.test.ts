import { describe, expect, it } from 'vitest';
import { gridToLines, renderGraph, STATUS_GLYPHS } from '../src/ui/canvas.js';
import { computeLayout, hitTest, scrollIntoView } from '../src/ui/layout.js';
import { parseMouseEvents } from '../src/ui/mouse.js';
import { UiInteractionPorts } from '../src/ui/ports.js';
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
    const overridden = computeLayout(WF, new Map([['impl', { dx: 10, dy: 3 }]]));
    expect(overridden.boxes.get('impl')!.x).toBe(base.boxes.get('impl')!.x + 10);
    expect(overridden.boxes.get('impl')!.y).toBe(base.boxes.get('impl')!.y + 3);
    expect(computeLayout(WF).boxes.get('impl')!.x).toBe(base.boxes.get('impl')!.x);
  });

  it('scrollIntoView brings an out-of-viewport box into view', () => {
    const layout = computeLayout(WF);
    const rev = layout.boxes.get('rev')!;
    const { ox, oy } = scrollIntoView(rev, { ox: 0, oy: 0, width: 20, height: 5 });
    expect(ox).toBeGreaterThan(0);
    expect(rev.x).toBeGreaterThanOrEqual(ox);
    expect(rev.x + rev.w).toBeLessThanOrEqual(ox + 20);
    expect(rev.y + rev.h).toBeLessThanOrEqual(oy + 5);
  });

  it('hitTest maps canvas coordinates to node ids', () => {
    const layout = computeLayout(WF);
    const impl = layout.boxes.get('impl')!;
    expect(hitTest(layout, impl.x + 1, impl.y + 1)).toBe('impl');
    expect(hitTest(layout, impl.x + impl.w + 3, impl.y)).toBeNull();
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

describe('mouse parsing (SGR)', () => {
  it('parses press, drag, and release with 0-based coordinates', () => {
    expect(parseMouseEvents('\x1b[<0;5;3M')).toEqual([{ kind: 'press', x: 4, y: 2, button: 0 }]);
    expect(parseMouseEvents('\x1b[<32;6;3M')).toEqual([{ kind: 'drag', x: 5, y: 2, button: 0 }]);
    expect(parseMouseEvents('\x1b[<0;6;3m')).toEqual([{ kind: 'release', x: 5, y: 2, button: 0 }]);
  });

  it('ignores non-mouse input entirely (graceful no-mouse fallback)', () => {
    expect(parseMouseEvents('hello\x1b[Aworld')).toEqual([]);
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
});
