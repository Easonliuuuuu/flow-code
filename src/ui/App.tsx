import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { join } from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { providerInfo, type ProviderId } from '../engine/providers.js';
import { windowFor } from '../init/SelectList.js';
import { nodeTypeAcceptsAgentStep } from '../registry/index.js';
import type { RunStateStore } from '../runstate/store.js';
import { readReport } from '../guest/reconcile.js';
import { effectiveTier, TIER_LABELS, tierDisclosure } from '../runstate/tier.js';
import { cacheReadTokens, cacheWriteTokens } from '../runstate/types.js';
import type { NodeStatus, RunState } from '../runstate/types.js';
import { driverLiveness, isAttached } from '../runstate/watch.js';
import { defaultSkillRoots, discoverSkills, type DiscoveredSkill } from '../skills/discover.js';
import { WORKFLOW_RELATIVE_PATH, type Workflow } from '../workflow/load.js';
import { resolveNodeModel } from '../workflow/modelResolution.js';
import { editRunningNode, WorkflowWriteError } from '../workflow/write.js';
import {
  gridToLines,
  nodeModelBadge,
  nodeSkillBadge,
  renderGraph,
  STATUS_GLYPHS,
  STATUS_ORDER,
} from './canvas.js';
import {
  ellipsis,
  formatDuration,
  formatTokens,
  outputDetailLines,
  spinnerFrame,
  totalTokens,
} from './nodeCard.js';
import { rateLimitSegments, type RateLimitTone } from './rateLimit.js';
import { agentLabelsFor, formatActivityRow, needsAttribution } from './activityRow.js';
import {
  BOX_HEIGHT,
  centerOnBox,
  clampOffset,
  clampZoom,
  computeLayout,
  hitTest,
  MAX_ZOOM,
  offscreenCounts,
  rowPitch,
  scrollIntoView,
  ZOOM_DENSITIES,
  type PositionOverrides,
} from './layout.js';
import { disableMouse, enableMouse, LEAKED_MOUSE_SEQUENCE, parseMouseEvents } from './mouse.js';
import { createModelListLoader, type ModelListLoader } from './modelListLoader.js';
import {
  applyPanelMove,
  applyPanelResize,
  dockedLayout,
  hitTestPanel,
  pinAfterScroll,
  HELP_HEIGHT_RATIO,
  MOVE_HANDLE,
  RESIZE_GRIP,
  tailWindow,
  type PanelRect,
} from './panel.js';
import { editableFields, parseFieldValue, type EditorField } from './nodeEditor.js';
import { helpKeyWidth, helpRows } from './help.js';
import type { UiInteractionPorts } from './ports.js';
import { renderMarkdown, renderPlain, segmentStyle } from './markdown.js';
import { applyLineEdit } from './textInput.js';
import { wrapText } from './textwrap.js';

/** Provenance context the run UI needs to distinguish a node's own model
 * choice from one inherited from the workflow's settings or the provider's
 * default — captured by `cmdRun` before it fills `settings.model` in with
 * the provider default, since that fill-in would otherwise erase the
 * distinction (see design.md's "Pass model provenance into the UI
 * explicitly"). */
export interface ModelContext {
  providerId: ProviderId | undefined;
  providerDefaultModel: string | undefined;
  workflowSettingsModel: string | undefined;
}

interface PanelDrag {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  origin: PanelRect;
}

/** The header line above the canvas, and the hint line below it when no panel is docked. */
const HEADER_ROWS = 1;
const FOOTER_ROWS = 1;

/**
 * Longest a panel's key hint may be. An 80-column terminal is the floor we
 * draw for; a docked panel spans it minus its border, padding and the resize
 * grip sharing the row.
 */
export const HINT_BUDGET = 80 - 2 - 2 - 2;

/** How often the viewer re-reads a run's reconciliation report, if one exists. */
const RECONCILE_POLL_MS = 2000;

/**
 * Prose (chat transcript, agent output, critique summaries) wraps to this at
 * most, however wide the panel itself is — a docked panel spans the full
 * terminal, and conversational sentences stretched across a very wide window
 * read as a sparse left-aligned column with a dead void on the right rather
 * than as text. Tabular content (diffs) isn't subject to this; it needs the
 * full width to avoid wrapping code lines.
 */
const MAX_PROSE_WIDTH = 100;

/** Spinner/elapsed-clock cadence: fast enough to read as motion, slow enough not to churn frames. */
const ANIMATION_INTERVAL_MS = 120;

/** One keypress of pan: a few columns / rows, not a whole screen. */
const PAN_STEP_X = 4;
const PAN_STEP_Y = 2;

export interface AppProps {
  workflow: Workflow;
  store: RunStateStore;
  ports: UiInteractionPorts;
  onExit: () => void;
  /** ctrl+c: interrupt the run rather than just closing the UI over it. */
  onInterrupt: () => void;
  modelContext: ModelContext;
  /**
   * Spectator mode (`flow-code watch`): the run belongs to another process,
   * and this UI only reads its state file. Turns the header into a
   * what-am-I-attached-to indicator and disables the keys that write to
   * `workflow.yaml` — see {@link WATCH_READ_ONLY_MESSAGE}.
   */
  watch?: boolean;
  /**
   * Set by `WorkflowHost` (`src/ui/index.ts`) when it could not derive a
   * workflow to show from the run it just attached to — a run document
   * carrying no recorded graph, or one whose recorded graph no longer
   * rehydrates (a node type this build doesn't have). Rendered in the
   * header; `workflow` keeps showing whatever shape was already on screen.
   */
  graphIssue?: string | null;
}

/** Matches the header's other signals: yellow warns, red is already failing. */
const RATE_LIMIT_COLORS: Record<RateLimitTone, string> = {
  normal: 'cyan',
  warn: 'yellow',
  critical: 'red',
};

/** Renders a config value as a human-readable string; falls back to compact JSON for nested shapes. */
function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      ? value.join(', ')
      : JSON.stringify(value);
  }
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Flattens an approval gate's diffs into a scrollable list of lines, one label header per diff. */
function diffLinesFor(diffs: Array<{ label?: string; diff: string }>): string[] {
  return diffs.flatMap((d) => [
    ...(d.label ? [`── ${d.label} ──`] : []),
    ...(d.diff.length > 0 ? d.diff.split('\n') : ['(no changes)']),
  ]);
}

/** GitHub-style +green/-red diff body, shared by the live approval panel and its post-decision replay. */
function DiffLines({ lines, start, visible }: { lines: string[]; start: number; visible: number }): React.ReactElement {
  return (
    <>
      {lines.slice(start, start + visible).map((line, i) => (
        <Text
          key={i}
          wrap="truncate-end"
          {...(line.startsWith('+') ? { color: 'green' } : line.startsWith('-') ? { color: 'red' } : {})}
          dimColor={line.startsWith('@@') || line.startsWith('──')}
        >
          {line || ' '}
        </Text>
      ))}
    </>
  );
}

/**
 * Title row of a panel. The whole row is a move zone (see hitTestPanel), so it
 * leads with a drag handle to say so.
 */
function PanelTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <Text dimColor>{MOVE_HANDLE} </Text>
      {children}
    </Box>
  );
}

/**
 * Bottom row of a panel: key hints on the left, and the resize grip sitting in
 * the very corner it grabs.
 *
 * The hint truncates rather than wrapping, so an over-long one does not push
 * the panel out of shape — it collides with the grip instead, mid-word, which
 * looks like the frame has sprung a leak. Keep each hint inside
 * {@link HINT_BUDGET}, and leave the rest to `?`: the panel is on screen, so
 * its ⠿ handle and ⇲ grip are already advertising themselves.
 */
function PanelFooter({ hint }: { hint: string }): React.ReactElement {
  return (
    <Box flexShrink={0} justifyContent="space-between">
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
      <Text dimColor>{RESIZE_GRIP}</Text>
    </Box>
  );
}

/**
 * Why `m`/`s`/`e` do nothing while watching: all three write to
 * `workflow.yaml`, and the run being watched is owned by another process that
 * reads config off the same file as each node starts. A spectator editing it
 * would change a run they aren't driving, from a window that shows no sign
 * that's what just happened.
 */
export const WATCH_READ_ONLY_MESSAGE = 'watching — workflow edits are disabled.';

export function App({
  workflow,
  store,
  ports,
  onExit,
  onInterrupt,
  modelContext,
  watch = false,
  graphIssue = null,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();

  const [runState, setRunState] = useState<RunState>(store.snapshot());
  const [frame, setFrame] = useState(0);
  const [, setPortsTick] = useState(0);
  const [focusIdx, setFocusIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState({ ox: 0, oy: 0 });
  const [overrides, setOverrides] = useState<PositionOverrides>(new Map());
  // How far out the canvas is zoomed: an index into ZOOM_DENSITIES (0 full,
  // 1 compact, 2 mini). null follows the auto rule — compact once the graph
  // outgrows the canvas — until the user takes the wheel or a key to it.
  //
  // One value, deliberately. Density used to be derived from two independent
  // states (a compact flag and a focus/overview mode), which meant nothing
  // could answer "how zoomed am I" and the two could disagree; it also tied
  // the camera to the zoom, so surveying the graph silently changed how
  // focus behaved. Camera is its own toggle now.
  const [zoomOverride, setZoomOverride] = useState<number | null>(null);
  // Where `o` returns to. Null means "back to the auto rule".
  const zoomBeforeMiniRef = useRef<number | null>(null);
  // 'center' hard-centers the focused node at the focus anchor; 'nudge' only
  // scrolls it into view. Independent of zoom.
  const [camera, setCamera] = useState<'center' | 'nudge'>('center');
  // Band-wrap is opt-out rather than unconditional: a graph that wraps oddly
  // (an edge routed through the wrong lane, say) still has a flat fallback
  // one keypress away instead of being stuck with it until the next release.
  const [wrapEnabled, setWrapEnabled] = useState(true);
  const [inputBuffer, setInputBuffer] = useState('');
  const [convCursor, setConvCursor] = useState(0);
  const [convSelected, setConvSelected] = useState<Set<string>>(new Set());
  // Test-command prompt: which candidates are checked, which commands the
  // user typed in themselves, and (when not null) the one being typed.
  const [testCommandCursor, setTestCommandCursor] = useState(0);
  const [testCommandSelected, setTestCommandSelected] = useState<Set<string>>(new Set());
  const [testCommandExtra, setTestCommandExtra] = useState<string[]>([]);
  const [testCommandInput, setTestCommandInput] = useState<string | null>(null);
  const [diffScroll, setDiffScroll] = useState(0);
  // null = following the live tail; a number pins the transcript to that
  // absolute row so new messages don't disturb a mid-scroll read.
  const [discussPin, setDiscussPin] = useState<number | null>(null);
  // Cursor into `discussState.options`, when the agent's last message offered
  // tappable choices; reset whenever a new set of options arrives.
  const [discussOptionCursor, setDiscussOptionCursor] = useState(0);
  // Same follow/pin model as discussPin, but for the two halves of the
  // default node panel (agent output, activity log) — independent, since
  // one can be much longer than the other.
  const [outputPin, setOutputPin] = useState<number | null>(null);
  const [activityPin, setActivityPin] = useState<number | null>(null);
  // null = docked (full width, pinned to the bottom, auto height). Set once the
  // panel is dragged or resized, and persists — including across different
  // panel content (Discuss/Approval/etc.) — until reset with ctrl+p.
  const [panelRect, setPanelRect] = useState<PanelRect | null>(null);
  // Mirrors panelDragRef into render state purely so the border can light up
  // while dragging — feedback that the grab actually landed on the handle.
  const [panelDragMode, setPanelDragMode] = useState<'move' | 'resize' | null>(null);
  const dragRef = useRef<{ id: string; lastX: number; lastY: number } | null>(null);
  const panelDragRef = useRef<PanelDrag | null>(null);

  // The node whichever per-node panel (model picker, skill picker, settings
  // editor) is currently open belongs to, or null when none is. Those panels
  // read and write `focusedNode`, so focus moving out from under one — which
  // only a mouse click can do, since their key handlers swallow tab — would
  // have them render one node's state and commit it to another.
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null);

  // Model picker: opened with `m` on the focused node (or a click on its
  // model badge). Renders in the same status panel as Discuss/Approval/etc.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCursor, setPickerCursor] = useState(0);
  // null = list mode; a string (possibly empty) = free-text entry, used when
  // the provider's model list failed to load.
  const [pickerFreeText, setPickerFreeText] = useState<string | null>(null);
  // Transient feedback for actions that don't open a panel: a decline (no
  // model field, no provider) or a failed save. Shown in the header, which —
  // unlike the bottom hint line — is visible no matter what panel is open.
  const [pickerMessage, setPickerMessage] = useState<string | null>(null);
  const pickerMessageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped after mutating a node's config in place (see confirmModel) so the
  // badge and detail view re-render from the change — that mutation isn't
  // itself React state.
  const [modelTick, setModelTick] = useState(0);
  const modelListLoadersRef = useRef<Map<ProviderId, ModelListLoader>>(new Map());
  const [modelListTick, setModelListTick] = useState(0);

  // Skill picker: opened with `s` on the focused node (or a click on its
  // skill badge). Multi-select — space toggles, enter confirms — unlike the
  // model picker, which picks exactly one.
  // Node settings editor: opened with `e` on the focused node. A list of
  // typed-in fields, unlike the pickers, which choose from a known set.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorCursor, setEditorCursor] = useState(0);
  // null = moving between fields; a string = typing into the current one.
  const [editorBuffer, setEditorBuffer] = useState<string | null>(null);

  // The key map (`?`). Not a per-node panel — it belongs to no node and
  // survives tabbing — so it stays out of `panelNodeId`'s bookkeeping.
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScroll, setHelpScroll] = useState(0);

  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerCursor, setSkillPickerCursor] = useState(0);
  const [skillPickerSelected, setSkillPickerSelected] = useState<Set<string>>(new Set());
  // Typing narrows the catalog by id/description; space still toggles the
  // item under the cursor rather than typing a literal space, since ids are
  // single-word and that keeps the one key that would otherwise be ambiguous
  // unambiguous.
  const [skillPickerQuery, setSkillPickerQuery] = useState('');

  useEffect(
    () => () => {
      if (pickerMessageTimeoutRef.current) clearTimeout(pickerMessageTimeoutRef.current);
    },
    [],
  );

  useEffect(() => store.subscribe(setRunState), [store]);

  // Reconciliation findings come from a file beside the run document rather
  // than from run-state, because the check is required to leave the run
  // byte-identical — its opinion of a run is not part of that run's own record
  // of what was reported. Polled rather than watched: the file only changes
  // when someone runs `flow-code reconcile`, and it is a few hundred bytes.
  const [reconcileFindings, setReconcileFindings] = useState<string[]>([]);
  useEffect(() => {
    if (!runState.runId) return;
    const read = (): void => {
      const report = readReport(runState.repoRoot, runState.runId);
      const nodes = [...new Set((report?.findings ?? []).map((f) => f.nodeId))];
      // Compared before setting so an unchanged report does not re-render the
      // whole canvas every tick.
      setReconcileFindings((prev) => (prev.join() === nodes.join() ? prev : nodes));
    };
    read();
    const timer = setInterval(read, RECONCILE_POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [runState.repoRoot, runState.runId]);
  useEffect(() => ports.subscribe(() => setPortsTick((t) => t + 1)), [ports]);

  // Animation clock for in-flight node cards (spinner, ticking elapsed time).
  // A node is in flight from the moment it starts until it reaches a terminal
  // status, even while its status is `waiting` (e.g. an approval gate) rather
  // than `running` — otherwise the elapsed-time display freezes mid-flight
  // and only snaps to the correct value once the node finishes. It only runs
  // while something is actually in flight, so an idle or finished graph costs
  // nothing and redraws nothing.
  const anyRunning = Object.values(runState.nodes).some(
    (n) => n.startedAt !== undefined && n.endedAt === undefined,
  );
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setFrame((f) => f + 1), ANIMATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const columns = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;

  const pendingApproval = ports.pendingApproval;
  const pendingConvergence = ports.pendingConvergence;
  const pendingTestCommands = ports.pendingTestCommands;
  /**
   * Everything the panel can offer: offline heuristics first (free and
   * usually right), then whatever the agent proposed if it was asked, then
   * anything typed by hand. De-duplicated, since detection and the agent
   * routinely land on the same command.
   */
  const testCommandCandidates = useMemo(() => {
    if (!pendingTestCommands) return [];
    const seen = new Set<string>();
    const out: Array<{ command: string; note: string }> = [];
    const add = (command: string, note: string): void => {
      if (seen.has(command)) return;
      seen.add(command);
      out.push({ command, note });
    };
    for (const command of pendingTestCommands.req.detected) add(command, 'detected');
    for (const p of pendingTestCommands.proposals) add(p.command, p.rationale);
    for (const command of testCommandExtra) add(command, 'typed');
    return out;
  }, [pendingTestCommands, pendingTestCommands?.proposals, testCommandExtra]);
  const discussState = ports.discussState;
  const discussActive = discussState?.active ?? false;
  const focusedId = workflow.order[Math.min(focusIdx, workflow.order.length - 1)] ?? null;
  const focusedNode = workflow.nodes.find((n) => n.id === focusedId);
  // Discuss and a pending approval gate are the blocking prompts you can step
  // away from: tabbing (or clicking) to another node hides them — still
  // paused, draft/scroll position and all — in favor of that node's own
  // panel, and tabbing back re-shows them. A gate's diff is exactly the kind
  // of thing you need other nodes' output in view to judge, so pinning it
  // open regardless of focus would defeat its own purpose. Convergence and
  // test-command prompts stay forced open regardless of focus, since those
  // are short single decisions where losing track of the request matters
  // more than being able to browse mid-decision.
  const discussPanelOpen = discussActive && discussState?.nodeId === focusedId;
  const pendingApprovalPanelOpen = pendingApproval !== null && pendingApproval.req.nodeId === focusedId;

  const panelOpen =
    expanded ||
    pendingApprovalPanelOpen ||
    pendingConvergence !== null ||
    pendingTestCommands !== null ||
    discussPanelOpen ||
    pickerOpen ||
    skillPickerOpen ||
    editorOpen ||
    helpOpen;
  const floating = panelRect !== null;

  // A run that flow-code did not execute gets a permanent line of its own
  // saying so, rather than a badge someone has to already know to look for.
  // The requirement is that what a tier did *not* guarantee is discoverable
  // without leaving the viewer, and a run whose graph looks identical to an
  // enforced one is exactly the case where a discoverable-on-demand
  // disclosure is discovered by nobody.
  //
  // Absent for an engine-driven run, which is every run that existed before
  // tiers did — so that layout, and everything measured against it, is
  // untouched for them.
  const tier = effectiveTier(runState.enforcement);
  const tierLine = tierDisclosure(tier);
  const headerRows = HEADER_ROWS + (tierLine ? 1 : 0);
  const docked = dockedLayout(
    { columns, rows },
    headerRows,
    helpOpen ? HELP_HEIGHT_RATIO : undefined,
  );
  // A docked, open panel reserves flow space below the canvas; a floating one
  // overlays it instead, so the canvas reclaims that space (same as closed).
  // When docked the canvas height must come from dockedLayout, or the panel
  // stops lining up with the rect the mouse is hit-tested against.
  const canvasHeight =
    panelOpen && !floating
      ? docked.canvasHeight
      : Math.max(1, rows - headerRows - FOOTER_ROWS);
  const activeRect = floating ? panelRect! : docked.rect;
  const panelHeight = activeRect.h;
  const canvasWidth = columns - 2;

  // The starting zoom, until the user takes the wheel or a key to it: full
  // cards, stepping out to compact if they don't fit. Decided from the full
  // layout's height so it can't oscillate — compacting never makes the graph
  // taller, so a graph that fits compact and triggered the step stays stepped.
  //
  // Measured on the *un-dragged* layout. Overrides move one node at a time by
  // arbitrary amounts, so folding them in let a single downward drag inflate
  // the height past the canvas and re-densify every card in the graph — and
  // since compacting shortens it again, drag it back and the whole thing
  // flips a second time. Density is a property of the graph, not of where you
  // happen to have parked one node.
  //
  // Measured against the *undocked* canvas height, not `canvasHeight` — a
  // docked panel (opened by `m`/`s`/`e`, an approval gate, …) reserves up to
  // 60% of the terminal for itself, and a graph tall enough to compact under
  // that reduced height would auto-compact the instant a panel opened and
  // un-compact the instant it closed. Every card would resize and shift
  // position on that swing, right as focus was moving on to the next click —
  // this is what silently changed the badge a click a moment later landed on.
  const undockedCanvasHeight = Math.max(1, rows - headerRows - FOOTER_ROWS);
  // Wrapping folds excess width into height, so the "is this graph too tall"
  // measurement below has to see the *wrapped* height or it under-triggers
  // compact for a graph that's wide rather than tall — canvasWidth doesn't
  // shift with a docked panel the way canvasHeight does, so no undocked/
  // docked split is needed for it the way there is for height.
  // exactOptionalPropertyTypes rejects `wrapWidth: undefined` outright —
  // omitting the key entirely is how LayoutOptions says "don't wrap".
  const wrapWidthOpt = wrapEnabled ? { wrapWidth: canvasWidth } : {};
  const measuredLayout = useMemo(
    () => computeLayout(workflow, undefined, { ...wrapWidthOpt }),
    [workflow, wrapEnabled, canvasWidth],
  );
  const fullLayout = useMemo(
    () => computeLayout(workflow, overrides, { ...wrapWidthOpt }),
    [workflow, overrides, wrapEnabled, canvasWidth],
  );
  // Mini isn't wrapped (yet) — nothing technical stops it (the mechanism is
  // density-agnostic), it just hasn't been asked for: mini's cards are
  // already narrow enough that a graph needs it far less often.
  const compactLayout = useMemo(
    () => computeLayout(workflow, overrides, { density: 'compact', ...wrapWidthOpt }),
    [workflow, overrides, wrapEnabled, canvasWidth],
  );
  const miniLayout = useMemo(
    () => computeLayout(workflow, overrides, { density: 'mini' }),
    [workflow, overrides],
  );
  const autoZoom = measuredLayout.height > undockedCanvasHeight ? 1 : 0;
  const zoom = zoomOverride ?? autoZoom;
  const density = ZOOM_DENSITIES[zoom]!;
  const layout = density === 'mini' ? miniLayout : density === 'compact' ? compactLayout : fullLayout;
  const viewport = { ...offset, width: canvasWidth, height: canvasHeight };
  // Panning is clamped so it can never leave the graph off-screen entirely,
  // and goes through one helper so the keyboard and the scroll wheel agree.
  const panBy = (dx: number, dy: number): void => {
    setOffset((o) => clampOffset(layout, { ox: o.ox + dx, oy: o.oy + dy, width: canvasWidth, height: canvasHeight }));
  };

  /**
   * Step the zoom. Positive is coarser (further out). Writing an explicit
   * level rather than nudging a nullable one means the first step from `auto`
   * lands where the user can see it went, and the auto rule stops fighting
   * them from then on.
   */
  const zoomBy = (steps: number): void => {
    zoomBeforeMiniRef.current = null;
    // Functional, because a spun wheel delivers several events in one stdin
    // chunk and they are handled in one pass with no render between them.
    // Reading the rendered `zoom` here meant every step after the first in a
    // burst recomputed from the same stale level and collapsed into one.
    setZoomOverride((prev) => clampZoom((prev ?? autoZoom) + steps));
  };
  const offscreen = offscreenCounts(layout, viewport);
  const offscreenHint = [
    offscreen.left > 0 ? `←${offscreen.left}` : '',
    offscreen.right > 0 ? `→${offscreen.right}` : '',
    offscreen.up > 0 ? `↑${offscreen.up}` : '',
    offscreen.down > 0 ? `↓${offscreen.down}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Scanned once per repo root rather than per keystroke — the picker just
  // filters/indexes into this list, same source `flow-code skills` lists.
  // Re-sorted project-first: a marketplace with hundreds of plugin skills
  // would otherwise bury the handful of skills this repo actually declares
  // under an alphabetically-earlier flood the user almost never wants here.
  const skillCatalog = useMemo(() => {
    const rank: Record<DiscoveredSkill['source'], number> = { project: 0, user: 1, plugin: 2, path: 3 };
    return discoverSkills(defaultSkillRoots(runState.repoRoot)).sort(
      (a, b) => rank[a.source] - rank[b.source] || a.id.localeCompare(b.id),
    );
  }, [runState.repoRoot]);
  const filteredSkillCatalog = useMemo(() => {
    const q = skillPickerQuery.trim().toLowerCase();
    if (!q) return skillCatalog;
    return skillCatalog.filter(
      (s) => s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skillCatalog, skillPickerQuery]);
  // The filtered set's length/order changes with every keystroke; a cursor
  // left pointing at the old index would land on an unrelated row (or past
  // the end), so it always snaps back to the top of the new result set.
  useEffect(() => {
    setSkillPickerCursor(0);
  }, [skillPickerQuery]);

  const showPickerMessage = (text: string): void => {
    setPickerMessage(text);
    if (pickerMessageTimeoutRef.current) clearTimeout(pickerMessageTimeoutRef.current);
    pickerMessageTimeoutRef.current = setTimeout(() => setPickerMessage(null), 3000);
  };

  const modelListLoaderFor = (provider: ProviderId): ModelListLoader => {
    let loader = modelListLoadersRef.current.get(provider);
    if (!loader) {
      const apiKeyEnvVar = providerInfo(provider).apiKeyEnvVar;
      loader = createModelListLoader(provider, apiKeyEnvVar ? process.env[apiKeyEnvVar] : undefined, () =>
        setModelListTick((t) => t + 1),
      );
      modelListLoadersRef.current.set(provider, loader);
    }
    return loader;
  };

  /** Opens the model picker, or explains why it can't — `true` when it opened. */
  const openModelPicker = (nodeId: string): boolean => {
    if (watch) {
      showPickerMessage(WATCH_READ_ONLY_MESSAGE);
      return false;
    }
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    if (!node.type.hasModelField) {
      showPickerMessage(`${node.type.displayName} nodes have no model to choose.`);
      return false;
    }
    if (!modelContext.providerId) {
      showPickerMessage('no provider configured — run `flow-code init` to choose one.');
      return false;
    }
    setPickerCursor(0);
    setPickerFreeText(null);
    setPanelNodeId(nodeId);
    setPickerOpen(true);
    modelListLoaderFor(modelContext.providerId).ensureLoaded();
    return true;
  };

  /** Opens the skill picker, or explains why it can't — `true` when it opened. */
  const openSkillPicker = (nodeId: string): boolean => {
    if (watch) {
      showPickerMessage(WATCH_READ_ONLY_MESSAGE);
      return false;
    }
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    if (!nodeTypeAcceptsAgentStep(node.type)) {
      showPickerMessage(`${node.type.displayName} nodes have no skills to attach.`);
      return false;
    }
    const catalogIds = new Set(skillCatalog.map((s) => s.id));
    const entries = (node.config as { skills?: string[] }).skills ?? [];
    setSkillPickerCursor(0);
    setSkillPickerQuery('');
    setSkillPickerSelected(new Set(entries.filter((e) => catalogIds.has(e))));
    setPanelNodeId(nodeId);
    setSkillPickerOpen(true);
    return true;
  };

  const editorFields = focusedNode ? editableFields(focusedNode) : [];
  const editorField = editorFields[Math.min(editorCursor, editorFields.length - 1)];

  const openEditor = (nodeId: string): void => {
    if (watch) {
      showPickerMessage(WATCH_READ_ONLY_MESSAGE);
      return;
    }
    setEditorCursor(0);
    setEditorBuffer(null);
    setPanelNodeId(nodeId);
    setEditorOpen(true);
  };

  /**
   * Close any per-node panel the focus has moved out from under. A click that
   * lands on another card is the only way to get here — every one of these
   * panels swallows tab — and leaving one open would have it go on rendering
   * the node it was opened for while `confirmSkills`/`confirmModel`/
   * `commitEditorField` wrote that node's pending edit to the newly focused
   * one. Opening a panel by clicking a badge sets both in the same commit, so
   * this can't close the panel it just opened.
   */
  useEffect(() => {
    if (panelNodeId === null || panelNodeId === focusedId) return;
    setPickerOpen(false);
    setSkillPickerOpen(false);
    setEditorOpen(false);
    setEditorBuffer(null);
    setPanelNodeId(null);
  }, [focusedId, panelNodeId]);

  /** Dismiss whichever per-node panel is open and release its claim on focus. */
  const closeNodePanel = (): void => {
    setPickerOpen(false);
    setSkillPickerOpen(false);
    setEditorOpen(false);
    setPanelNodeId(null);
  };

  /**
   * A workflow swap (`watch` rehydrating a different run's recorded graph
   * onto an already-mounted `WorkflowHost` — see `src/ui/index.ts`) leaves
   * `focusIdx` and any open per-node panel pointing at whichever node used to
   * sit there. Reset explicitly rather than relying on `focusIdx`'s
   * incidental `Math.min` clamp, which is crash-safe but would otherwise
   * settle focus on an unrelated node. Runs harmlessly once on the `run`
   * path's initial mount too, since `workflow` there never changes again.
   */
  useEffect(() => {
    setFocusIdx(0);
    closeNodePanel();
  }, [workflow]);

  /**
   * Writes one edited field to disk and to the same in-memory `WorkflowNode`
   * the engine reads at node-start time, so a node that hasn't run yet picks
   * the change up without restarting the run — the pattern confirmModel and
   * confirmSkills already use.
   */
  const commitEditorField = (nodeId: string, field: EditorField, input: string): void => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const parsed = parseFieldValue(field, input);
    if (!parsed.ok) {
      showPickerMessage(parsed.error);
      return;
    }
    const path = join(runState.repoRoot, WORKFLOW_RELATIVE_PATH);
    let result;
    try {
      result =
        parsed.kind === 'number'
          ? editRunningNode(path, store, nodeId, { kind: 'budgetTokens', value: parsed.value })
          : editRunningNode(path, store, nodeId, {
              kind: 'configString',
              field: field.key,
              value: parsed.value,
            });
    } catch (err) {
      showPickerMessage(
        err instanceof WorkflowWriteError ? err.message : `could not save ${field.label}: ${String(err)}`,
      );
      return;
    }
    // Mutate the same in-memory `WorkflowNode` the engine reads at node-start
    // time, rather than swapping it for `editRunningNode`'s freshly-built
    // one — so a node that hasn't run yet picks the change up without
    // restarting the run.
    const resultNode = result.nodes.find((n) => n.id === nodeId)!;
    node.config = resultNode.config;
    if (resultNode.budget) node.budget = resultNode.budget;
    else delete node.budget;
    setModelTick((t) => t + 1);
    setEditorBuffer(null);
  };

  /**
   * Writes `model` to the node's config on disk and, so the current run
   * picks it up without a restart, on the same in-memory `WorkflowNode`
   * object the engine reads at node-start time (mirroring the fallback
   * `cmdRun` already applies to `workflow.settings.model`). Selecting the
   * model the node would already resolve to by default clears the override
   * instead of writing a redundant one.
   */
  const confirmModel = (nodeId: string, model: string): void => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const toWrite = model === workflow.settings.model ? null : model;
    let result;
    try {
      result = editRunningNode(join(runState.repoRoot, WORKFLOW_RELATIVE_PATH), store, nodeId, {
        kind: 'model',
        value: toWrite,
      });
    } catch (err) {
      showPickerMessage(
        err instanceof WorkflowWriteError ? err.message : `could not save model: ${String(err)}`,
      );
      return;
    }
    node.config = result.nodes.find((n) => n.id === nodeId)!.config;
    setModelTick((t) => t + 1);
  };

  /**
   * Writes the selected skill ids to the node's config on disk and, so the
   * current run picks it up without a restart, on the same in-memory
   * `WorkflowNode` the engine reads — same pattern as confirmModel. Entries
   * the picker didn't offer (a hand-edited repo-relative path, say) are left
   * in place rather than dropped.
   */
  const confirmSkills = (nodeId: string, selected: Set<string>): void => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const catalogIds = new Set(skillCatalog.map((s) => s.id));
    const entries = (node.config as { skills?: string[] }).skills ?? [];
    const preserved = entries.filter((e) => !catalogIds.has(e));
    const toWrite = [...preserved, ...selected];
    let result;
    try {
      result = editRunningNode(join(runState.repoRoot, WORKFLOW_RELATIVE_PATH), store, nodeId, {
        kind: 'skills',
        value: toWrite,
      });
    } catch (err) {
      showPickerMessage(
        err instanceof WorkflowWriteError ? err.message : `could not save skills: ${String(err)}`,
      );
      return;
    }
    const resultNode = result.nodes.find((n) => n.id === nodeId)!;
    node.config = resultNode.config;
    node.skills = resultNode.skills;
    setModelTick((t) => t + 1);
  };

  // 'center' hard-centers the focused node near the upper-left of the canvas;
  // 'nudge' only scrolls it into view — what you want while surveying many
  // nodes rather than spotlighting one. A preference of its own, not a
  // side effect of how far out the canvas happens to be zoomed.
  //
  // Hard-centering fires only when the *subject* changes (focus moved, or the
  // view switched under it). It used to fire on any layout change, which made
  // dragging a node self-amplifying: each mouse event moved the box, the
  // re-center panned the viewport by the same amount, and the next event's
  // delta was measured against that pan — six cells of pointer travel sent a
  // node twenty-one cells and dragged the camera along with it, so the whole
  // rest of the graph appeared to slide out of order. Every other layout
  // change now gets the gentler nudge, which is a no-op while the box is
  // already on screen and still edge-scrolls when a drag reaches the border.
  const centeredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedId) return;
    const box = layout.boxes.get(focusedId);
    if (!box) return;
    const subject = `${focusedId} ${camera} ${density}`;
    const subjectChanged = centeredForRef.current !== subject;
    centeredForRef.current = subject;
    setOffset((prev) => {
      const viewport = { ...prev, width: canvasWidth, height: canvasHeight };
      const next =
        camera === 'center' && subjectChanged ? centerOnBox(box, viewport) : scrollIntoView(box, viewport);
      const clamped = clampOffset(layout, { ...next, width: canvasWidth, height: canvasHeight });
      // Bail out (same reference) rather than a same-valued new object, so
      // React skips the redundant re-render when the box was already in view.
      return clamped.ox === prev.ox && clamped.oy === prev.oy ? prev : clamped;
    });
  }, [focusedId, layout, camera, density, canvasWidth, canvasHeight]);

  // Auto-focus a gate when its approval request arrives.
  useEffect(() => {
    if (pendingApproval) {
      const idx = workflow.order.indexOf(pendingApproval.req.nodeId);
      if (idx >= 0) setFocusIdx(idx);
      setDiffScroll(0);
    }
  }, [pendingApproval, workflow.order]);

  // Reset diff scroll when focus lands on a different node, so an approval
  // gate's replayed diff always opens at the top rather than wherever the
  // previously-viewed node's diff happened to leave it. Skipped while a gate
  // is actively awaiting a decision — `diffScroll` is shared with its live
  // panel, and tabbing away to peek at other nodes (the panel hides, but the
  // request is still the same one) shouldn't lose the read position in the
  // diff you're deciding on.
  useEffect(() => {
    if (!pendingApproval) setDiffScroll(0);
  }, [focusedId, pendingApproval]);

  useEffect(() => {
    if (pendingConvergence) {
      setConvCursor(0);
      setConvSelected(new Set());
    }
  }, [pendingConvergence]);

  const pickerModelListState = modelContext.providerId
    ? modelListLoaderFor(modelContext.providerId).getState()
    : null;
  // A failed fetch degrades to free-text entry automatically — the user
  // never has to notice the list came back empty and ask for a text box.
  useEffect(() => {
    if (pickerOpen && pickerFreeText === null && pickerModelListState?.status === 'failed') {
      setPickerFreeText('');
    }
  }, [pickerOpen, pickerFreeText, modelListTick, pickerModelListState?.status]);

  const focusedNodeResolvedModel = focusedNode
    ? resolveNodeModel(focusedNode.config, modelContext.workflowSettingsModel, modelContext.providerDefaultModel)
    : null;

  // Every loop-back the focused node is an end of, in the direction it runs.
  // The canvas badge can only name one end and count the rest — a card has
  // no room for `↺test, validate, review` — so the full list, and each
  // loop's attempt budget, land here instead.
  const focusedLoops = useMemo(() => {
    if (!focusedId) return [];
    return workflow.graph.allLoopbacks().flatMap((loop) => {
      const cap = loop.maxAttempts ? ` (max ${loop.maxAttempts})` : '';
      // The badge names the one loop that fired; when several have, only this
      // list can say which — so each one says so on its own row.
      const fired =
        (runState.nodes[loop.to]?.attempt ?? 1) > 1 &&
        (runState.nodes[loop.from]?.priorAttempts?.length ?? 0) > 0
          ? ' — fired'
          : '';
      if (loop.from === focusedId) return [`↺ returns to ${loop.to}${cap}${fired}`];
      if (loop.to === focusedId) return [`↻ returns from ${loop.from}${cap}${fired}`];
      return [];
    });
  }, [workflow, focusedId, runState]);

  // Wrapped transcript rows for the Discuss panel, and the scrollback window
  // into them (see tailWindow's doc comment for the follow/pin model).
  const discussTranscriptWidth = Math.max(10, Math.min(activeRect.w - 6, MAX_PROSE_WIDTH));
  // Panel width minus borders, padding, the "> " prompt and the caret cell.
  const discussInputWidth = Math.max(4, activeRect.w - 7);
  const discussRows = useMemo(() => {
    if (!discussState) return [];
    return discussState.transcript.flatMap((entry, entryIdx) => {
      const prefix = entry.role === 'user' ? 'you: ' : 'agent: ';
      const body = Math.max(4, discussTranscriptWidth - prefix.length);
      // The user typed plain text; the agent answers in markdown, so only the
      // agent's side is parsed — nobody wants their own `*` reinterpreted.
      const lines =
        entry.role === 'user' ? renderPlain(entry.text, body) : renderMarkdown(entry.text, body);
      const color = entry.role === 'user' ? 'cyan' : 'green';
      return lines.map((line, lineIdx) => ({
        key: `${entryIdx}-${lineIdx}`,
        prefix: lineIdx === 0 ? prefix : ' '.repeat(prefix.length),
        color,
        segments: line.segments,
      }));
    });
  }, [discussState, discussTranscriptWidth]);
  // Rows the input area claims below the transcript, which the transcript
  // window has to leave free or the newest message is the thing that gets
  // clipped: the caret line, the "how to finish" line under it, and one row per
  // offered option. While the agent is replying it is a single spinner row.
  const discussInputRows = discussState?.awaitingUser
    ? 2 + (discussState.options?.length ?? 0)
    : 1;
  const discussWindow = tailWindow(
    discussRows.length,
    Math.max(1, panelHeight - 4 - discussInputRows),
    discussPin,
  );

  // Same tail/scroll treatment for the default node panel's two halves —
  // hoisted out of the panel's render (rather than computed inline like the
  // rest of that view) so the keyboard and mouse-wheel handlers below can
  // read the current window too, same reason discussWindow lives up here.
  const nodePanelActivity = useMemo(
    () => (focusedNode ? runState.activity.filter((e) => e.nodeId === focusedNode.id) : []),
    [runState.activity, focusedNode],
  );
  // Empty unless this node's log came from more than one agent, which is what
  // keeps the column off single-agent nodes rather than padding every row.
  const nodePanelAgentLabels = useMemo(
    () => (needsAttribution(nodePanelActivity) ? agentLabelsFor(nodePanelActivity) : new Map()),
    [nodePanelActivity],
  );
  const nodePanelOutputWidth = Math.max(10, Math.min(activeRect.w - 4, MAX_PROSE_WIDTH));
  // Deliberately not memoized: store.liveOutputFor reads a buffer that
  // mutates outside React state, so it has to be re-read on every render —
  // keying a memo to `frame` would only pick up new output on the next
  // animation tick instead of the render that actually revealed the panel.
  //
  // A node whose entire reply is a JSON object (spec, validate, review, and a
  // discussion's closing turn) streamed that JSON live as its transcript —
  // there is no prose to separate it from. Once the node is done and that
  // JSON has parsed into `output`, the formatted breakdown replaces the raw
  // blob rather than sitting below it; the parsed fields are strictly more
  // readable than the text they came from, so keeping both is only clutter.
  const nodePanelDetail = focusedNode
    ? outputDetailLines(focusedNode, runState.nodes[focusedNode.id]?.output ?? null)
    : null;
  const nodePanelLive = focusedNode ? store.liveOutputFor(focusedNode.id) : '';
  const nodePanelLiveLines =
    nodePanelDetail !== null
      ? nodePanelDetail.flatMap((line) => wrapText(line, nodePanelOutputWidth))
      : nodePanelLive.length > 0
        ? nodePanelLive
            .trimEnd()
            .split('\n')
            .flatMap((line) => wrapText(line.replace(/\t/g, '    '), nodePanelOutputWidth))
        : [];
  // Rows left for output + activity: the panel minus its borders, title,
  // config line, activity separator and footer — mirrors the panel render's
  // own bodyBudget math (kept in sync there rather than shared, since the
  // render's version also has to account for the approval-gate replay case).
  const nodePanelBodyBudget = Math.max(2, panelHeight - 6);
  const nodePanelOutputBudget = Math.max(1, Math.floor(nodePanelBodyBudget / 2));
  const nodePanelActivityBudget = Math.max(1, nodePanelBodyBudget - nodePanelOutputBudget);
  const outputWindow = tailWindow(nodePanelLiveLines.length, nodePanelOutputBudget, outputPin);
  const activityWindow = tailWindow(nodePanelActivity.length, nodePanelActivityBudget, activityPin);
  // A page-sized jump for diff scrolling (approval gate, live or replay) —
  // same panelHeight-based step Discuss's PageUp/PageDown already uses.
  const diffPageStep = Math.max(1, panelHeight - 6);
  // Whether the expanded panel is showing a decided approval gate's diff
  // replay rather than the default output/activity view — same condition
  // the panel's own render branches on, reused here so the wheel handler
  // (which can't run that JSX) knows which pin(s) a scroll should move.
  const nodePanelIsDiffReplay =
    focusedNode?.type.id === 'approval-gate' &&
    Array.isArray(
      (runState.nodes[focusedNode.id]?.output as { diffs?: unknown } | undefined)?.diffs,
    );

  // The key map and its scroll window. It is taller than a short terminal's
  // panel, so it scrolls like any other panel body rather than quietly
  // dropping its last sections — which would be the mouse and text-editing
  // keys, the two nobody would think to go looking for.
  const helpAllRows = useMemo(() => helpRows({ watch }), [watch]);
  const helpColumnWidth = useMemo(() => helpKeyWidth(helpAllRows), [helpAllRows]);
  const helpVisible = Math.max(1, panelHeight - 4);
  const helpMaxScroll = Math.max(0, helpAllRows.length - helpVisible);
  const helpStart = Math.min(helpScroll, helpMaxScroll);

  /**
   * Whether a prompt is blocking on this node. A blocking prompt owns the
   * keyboard outright, so `m`/`s` can't reach the pickers while one is up
   * (see the mode chain in useInput) — and the mouse has to honour the same
   * rule. A badge click that opened a picker underneath one of these left it
   * invisible behind the higher-priority panel and keyboard-unreachable, then
   * sprang it on you the moment the prompt was answered. Discuss and a
   * pending approval gate are judged per node, since a paused discussion (or
   * a gate awaiting a decision) elsewhere in the graph is exactly the case
   * tabbing away is meant to allow.
   */
  const blockingPromptFor = (nodeId: string): boolean =>
    (pendingApproval !== null && pendingApproval.req.nodeId === nodeId) ||
    pendingConvergence !== null ||
    pendingTestCommands !== null ||
    (discussActive && discussState?.nodeId === nodeId);

  // The order renderGraph paints cards in — last one wins where two overlap,
  // so hit-testing has to walk it backwards to agree with what's on screen.
  const drawOrder = useMemo(() => workflow.nodes.map((n) => n.id), [workflow]);

  // Everything the mouse handler reads, mirrored into a ref. The handler is
  // registered once (see below) so it can't take these as effect deps: doing
  // so re-ran the effect on every render, writing mouse mode-set escapes into
  // the middle of Ink's frames on every streamed token.
  const mouseStateRef = useRef({
    layout,
    offset,
    activeRect,
    panelOpen,
    expanded,
    focusedNode,
    discussPanelOpen,
    discussWindow,
    helpOpen,
    helpMaxScroll,
    nodePanelIsDiffReplay,
    outputWindow,
    activityWindow,
    nodePanelOutputBudget,
    pendingApprovalPanelOpen,
    columns,
    rows,
    canvasWidth,
    canvasHeight,
    density,
    drawOrder,
    openModelPicker,
    openSkillPicker,
    blockingPromptFor,
    zoomBy,
  });
  useEffect(() => {
    mouseStateRef.current = {
      layout,
      offset,
      activeRect,
      panelOpen,
      expanded,
      focusedNode,
      discussPanelOpen,
      discussWindow,
      helpOpen,
      helpMaxScroll,
      nodePanelIsDiffReplay,
      outputWindow,
      activityWindow,
      nodePanelOutputBudget,
      pendingApprovalPanelOpen,
      columns,
      rows,
      canvasWidth,
      canvasHeight,
      density,
      drawOrder,
      openModelPicker,
      openSkillPicker,
      blockingPromptFor,
      zoomBy,
    };
  });

  // A fresh discussion (or re-entering one) starts following the live tail.
  useEffect(() => {
    setDiscussPin(null);
  }, [discussState?.nodeId, discussActive]);

  // A new set of options starts back at the top rather than carrying over a
  // cursor position that may now point past the end of a shorter list.
  useEffect(() => {
    setDiscussOptionCursor(0);
  }, [discussState?.options]);

  // Moving focus to a different node starts its panel following the live
  // tail too, rather than carrying over a scroll position from whatever was
  // focused before.
  useEffect(() => {
    setOutputPin(null);
    setActivityPin(null);
  }, [focusedNode?.id]);

  // Auto-focus a discuss node the moment it starts awaiting a reply — same
  // reasoning as the approval-gate effect below: since discussPanelOpen only
  // shows the conversation while its node is focused, a discussion beginning
  // while you're looking elsewhere must still surface itself rather than
  // wait silently for you to notice and tab over.
  useEffect(() => {
    if (!discussActive || !discussState) return;
    const idx = workflow.order.indexOf(discussState.nodeId);
    if (idx >= 0) setFocusIdx(idx);
  }, [discussState?.nodeId, discussActive, workflow.order]);

  // Mouse: enhancement layer only. Terminals without mouse reporting simply
  // never emit these sequences; everything stays keyboard-operable.
  useEffect(() => {
    if (!stdin || !stdout.isTTY) return;
    enableMouse(stdout);
    const onData = (data: Buffer | string) => {
      const events = parseMouseEvents(data.toString());
      for (const event of events) {
        const {
          layout,
          offset,
          activeRect,
          panelOpen,
          expanded,
          focusedNode,
          discussPanelOpen,
          helpOpen,
          helpMaxScroll,
          nodePanelIsDiffReplay,
          outputWindow,
          activityWindow,
          nodePanelOutputBudget,
          pendingApprovalPanelOpen,
          columns,
          rows,
          canvasWidth,
          canvasHeight,
          density,
          drawOrder,
          openModelPicker,
          openSkillPicker,
          blockingPromptFor,
          zoomBy,
        } = mouseStateRef.current;
        // Rows above the output pane in the default node panel: top border,
        // title, config line — matches nodePanelBodyBudget's own accounting
        // (App.tsx, "Rows left for output + activity" comment). The optional
        // model/skills/tokens/attempt lines above aren't counted here either,
        // same pre-existing approximation as that budget itself, so a wheel
        // near the output/activity boundary on a node with several of those
        // lines showing may land a tick on the wrong half — low-stakes since
        // it's just one scroll tick.
        const nodePanelHeaderRows = 3;
        const nodePanelOpen =
          expanded && focusedNode !== undefined && !discussPanelOpen && !nodePanelIsDiffReplay;
        const overPanel =
          panelOpen &&
          event.x >= activeRect.x &&
          event.x < activeRect.x + activeRect.w &&
          event.y >= activeRect.y &&
          event.y < activeRect.y + activeRect.h;

        if (event.kind === 'press' && event.button === 0) {
          const zone = panelOpen ? hitTestPanel(activeRect, event.x, event.y) : null;
          if (zone) {
            panelDragRef.current = { mode: zone, startX: event.x, startY: event.y, origin: activeRect };
            setPanelDragMode(zone);
            continue;
          }
          if (overPanel) continue; // clicks inside panel content (not its border) aren't a canvas drag
          const canvasX = event.x + offset.ox;
          const canvasY = event.y - headerRows + offset.oy;
          const id = hitTest(layout, canvasX, canvasY, drawOrder);
          if (id) {
            setFocusIdx(Math.max(0, workflow.order.indexOf(id)));
            const box = layout.boxes.get(id);
            // The model/skill badge is the only thing ever drawn on a box's
            // type-label row (see canvas.ts); clicking that row when a badge is
            // present opens the picker instead of starting a position drag, and
            // every other row is unaffected.
            //
            // Row 2 is the type-label row on a *full* card only. A compact card
            // is three rows — border, title, border — and draws no badge at all,
            // so without the height check a click on its bottom border opened a
            // picker out of nowhere; auto-compacting means that was one third of
            // every card as soon as the graph outgrew the canvas.
            const onBadgeRow =
              box !== undefined && box.h === BOX_HEIGHT && canvasY === box.y + 2 && !blockingPromptFor(id);
            const badge = !onBadgeRow
              ? null
              : nodeModelBadge(workflow, id) !== null
                ? 'model'
                : nodeSkillBadge(workflow, id) !== null
                  ? 'skill'
                  : null;
            if (badge === 'model') {
              openModelPicker(id);
            } else if (badge === 'skill') {
              openSkillPicker(id);
            } else {
              // Screen coordinates, deliberately: a canvas-relative origin
              // folds any viewport pan that happens mid-drag into the next
              // delta, which is half of what made dragging run away. What the
              // pointer travels is what the node moves.
              dragRef.current = { id, lastX: event.x, lastY: event.y };
            }
          }
        } else if (event.kind === 'drag' && panelDragRef.current) {
          const drag = panelDragRef.current;
          const dx = event.x - drag.startX;
          const dy = event.y - drag.startY;
          setPanelRect(
            drag.mode === 'resize'
              ? applyPanelResize(drag.origin, dx, dy, { columns, rows })
              : applyPanelMove(drag.origin, dx, dy, { columns, rows }),
          );
        } else if (event.kind === 'drag' && dragRef.current) {
          const drag = dragRef.current;
          const box = layout.boxes.get(drag.id);
          if (!box) continue;
          // Clamped against where the box actually is, so the delta that gets
          // banked is the delta that gets drawn. Leaving the clamp to
          // computeLayout instead let the stored override drift away from the
          // rendered position, which is only harmless while every reader
          // re-applies the identical clamp — and `dyRows` is now replayed
          // against three different base layouts.
          const dx = Math.max(event.x - drag.lastX, -box.x);
          const dy = Math.max(event.y - drag.lastY, -box.y);
          if (dx !== 0 || dy !== 0) {
            // Advance only by what was actually applied, so a clamped axis
            // doesn't bank the leftover for the next event either.
            drag.lastX += dx;
            drag.lastY += dy;
            // Recorded in the zoom-invariant units the overrides are stored
            // in, against the layout the drag is actually happening on, so an
            // arrangement made zoomed out is still that arrangement zoomed in.
            const pitch = rowPitch(density);
            const span = Math.max(1, layout.baseWidth);
            setOverrides((prev) => {
              const next = new Map(prev);
              const cur = next.get(drag.id) ?? { dxFrac: 0, dyRows: 0 };
              // Session-only: never written back to the workflow file.
              next.set(drag.id, {
                dxFrac: cur.dxFrac + dx / span,
                dyRows: cur.dyRows + dy / pitch,
              });
              return next;
            });
          }
        } else if (event.kind === 'release') {
          dragRef.current = null;
          panelDragRef.current = null;
          setPanelDragMode(null);
        } else if (event.kind === 'scroll') {
          // Up and left are the "backwards" ends of their axes: wheel-up
          // zooms in, scrolls back through history, and pans left.
          const backwards = event.direction === 'up' || event.direction === 'left';
          // A sideways swipe on a trackpad arrives as its own direction; a
          // wheel with no sideways axis reports shift instead, the same
          // convention a browser uses. Either way it pans the canvas, and
          // never a panel — nothing in one scrolls sideways.
          const sideways = event.direction === 'left' || event.direction === 'right' || event.shift;
          // Ctrl+wheel zooms the canvas — but only over the canvas. Over an
          // open panel the wheel belongs to whatever is being read there, and
          // a stray ctrl while scrolling a conversation should not resize the
          // graph behind it. Wheel-up is zoom *in*, matching every other
          // zoomable surface.
          if (event.ctrl && !overPanel) {
            zoomBy(backwards ? -1 : 1);
          } else if (sideways) {
            // Written out rather than routed through `panBy`, for the same
            // reason the vertical pan below is: this handler is registered
            // once, so it has to read the viewport off the ref instead of
            // closing over a `layout`/`canvasWidth` from first render.
            if (!overPanel) {
              setOffset((o) =>
                clampOffset(layout, {
                  ox: o.ox + (backwards ? -PAN_STEP_X : PAN_STEP_X),
                  oy: o.oy,
                  width: canvasWidth,
                  height: canvasHeight,
                }),
              );
            }
          } else if (overPanel && helpOpen) {
            setHelpScroll((s) => Math.min(helpMaxScroll, Math.max(0, s + (backwards ? -3 : 3))));
          } else if (overPanel && discussPanelOpen) {
            setDiscussPin(pinAfterScroll(mouseStateRef.current.discussWindow, backwards ? 3 : -3));
          } else if (overPanel && (pendingApprovalPanelOpen || nodePanelIsDiffReplay)) {
            // Same 3-row-per-tick step as every other wheel-scrolled surface
            // here (discuss, node panel below) — this used to move 1 row/tick,
            // which read as noticeably slower under the mouse for no reason.
            setDiffScroll((s) => Math.max(0, s + (backwards ? -3 : 3)));
          } else if (overPanel && nodePanelOpen) {
            const splitY = activeRect.y + nodePanelHeaderRows + nodePanelOutputBudget;
            if (event.y < splitY) {
              setOutputPin(pinAfterScroll(outputWindow, backwards ? 3 : -3));
            } else {
              setActivityPin(pinAfterScroll(activityWindow, backwards ? 3 : -3));
            }
          } else {
            setOffset((o) =>
              clampOffset(layout, {
                ox: o.ox,
                oy: o.oy + (backwards ? -PAN_STEP_Y : PAN_STEP_Y),
                width: canvasWidth,
                height: canvasHeight,
              }),
            );
          }
        }
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      disableMouse(stdout);
    };
  }, [stdin, stdout, workflow.order]);

  useInput((input, key) => {
    // ctrl+c always interrupts, regardless of mode — takes over from Ink's
    // default exitOnCtrlC so the engine actually stops instead of the UI
    // just closing over a still-running session.
    if (key.ctrl && input === 'c') {
      onInterrupt();
      return;
    }

    // Ink's keypress parser doesn't recognize SGR mouse sequences and, after
    // stripping the leading ESC byte, hands the rest back as literal `input`
    // text. Without this guard that text lands character-for-character in
    // whatever's capturing keyboard input right now (e.g. the discuss box).
    if (LEAKED_MOUSE_SEQUENCE.test(input)) {
      return;
    }

    // Reset the panel to docked (full width, bottom, default height) —
    // works in every mode, including while Discuss has the keyboard, since
    // ctrl-combos never collide with typed text.
    if (key.ctrl && input === 'p') {
      setPanelRect(null);
      return;
    }

    // Panning the canvas works in every mode, including while Discuss or a
    // picker holds the keyboard — those return unconditionally below, and a
    // graph you cannot scroll while the panel that covers it is open is a
    // graph you cannot read. Shift-modified so it never collides with typed
    // text or with a picker's own arrow-key cursor.
    if (key.shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
      if (key.leftArrow) panBy(-PAN_STEP_X, 0);
      else if (key.rightArrow) panBy(PAN_STEP_X, 0);
      else if (key.upArrow) panBy(0, -PAN_STEP_Y);
      else panBy(0, PAN_STEP_Y);
      return;
    }

    // Discussion input mode captures the keyboard — but only while its node
    // is the one focused. Tab/shift+tab step away to browse the rest of the
    // graph (the conversation stays paused, draft and all) rather than being
    // swallowed; tabbing back onto this node re-enters the same block.
    if (discussPanelOpen && discussState) {
      if (key.tab && key.shift) {
        setFocusIdx((i) => (i + workflow.order.length - 1) % workflow.order.length);
        return;
      }
      if (key.tab) {
        setFocusIdx((i) => (i + 1) % workflow.order.length);
        return;
      }
      // Options offered alongside the agent's last message: arrow keys move
      // the cursor, enter (below) picks the highlighted one unless the user
      // has started typing a custom answer instead.
      const options = discussState.options;
      if (discussState.awaitingUser && options && options.length > 0) {
        if (key.upArrow) {
          setDiscussOptionCursor((c) => (c - 1 + options.length) % options.length);
          return;
        }
        if (key.downArrow) {
          setDiscussOptionCursor((c) => (c + 1) % options.length);
          return;
        }
      }
      if (key.pageUp) {
        setDiscussPin(pinAfterScroll(discussWindow, Math.max(1, panelHeight - 6)));
        return;
      }
      if (key.pageDown) {
        setDiscussPin(pinAfterScroll(discussWindow, -Math.max(1, panelHeight - 6)));
        return;
      }
      // Escape backs out of a draft first, same as the node-settings editor
      // and every picker — an abandoned draft shouldn't cost you the
      // conversation too. With no draft, it's the one modal here that
      // otherwise has no way to back out short of typing /done or /exit.
      if (key.escape) {
        if (inputBuffer.length > 0) {
          setInputBuffer('');
        } else {
          setDiscussPin(null);
          ports.submitUserMessage(null);
        }
        return;
      }
      if (key.return) {
        const text = inputBuffer.trim();
        if (text.length === 0 && options && options.length > 0) {
          setDiscussPin(null);
          ports.submitUserMessage(options[discussOptionCursor]!);
          return;
        }
        setInputBuffer('');
        setDiscussPin(null);
        if (text === '/done' || text === '/exit') ports.submitUserMessage(null);
        else if (text.length > 0) ports.submitUserMessage(text);
        return;
      }
      const editedDraft = applyLineEdit(inputBuffer, input, key);
      if (editedDraft !== null) {
        setInputBuffer(editedDraft);
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuffer((b) => b.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
        setInputBuffer((b) => b + input);
      }
      return;
    }

    // Test commands: a Test node reached execution still holding the
    // scaffolded placeholder and is asking what it should actually run.
    if (pendingTestCommands) {
      const { resolve } = pendingTestCommands;
      if (testCommandInput !== null) {
        const editedCommand = applyLineEdit(testCommandInput, input, key);
        if (key.escape) {
          setTestCommandInput(null);
        } else if (key.return) {
          const command = testCommandInput.trim();
          if (command.length > 0) {
            setTestCommandExtra((prev) => [...prev, command]);
            setTestCommandSelected((prev) => new Set([...prev, command]));
          }
          setTestCommandInput(null);
        } else if (editedCommand !== null) {
          setTestCommandInput(editedCommand);
        } else if (key.backspace || key.delete) {
          setTestCommandInput((b) => (b ?? '').slice(0, -1));
        } else if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
          setTestCommandInput((b) => (b ?? '') + input);
        }
        return;
      }
      if (key.escape) {
        // Skipping is a real answer — a project with no test suite yet.
        resolve(null);
        return;
      }
      if (key.return) {
        resolve(testCommandCandidates.filter((c) => testCommandSelected.has(c.command)).map((c) => c.command));
        return;
      }
      if (input === 'a') {
        setTestCommandInput('');
        return;
      }
      if (input === 'd') {
        // Reading the repo costs a session, so it happens only when asked.
        void ports.discoverTestCommands();
        return;
      }
      if (testCommandCandidates.length === 0) return;
      if (key.upArrow || input === 'k') {
        setTestCommandCursor((c) => (c + testCommandCandidates.length - 1) % testCommandCandidates.length);
      } else if (key.downArrow || input === 'j') {
        setTestCommandCursor((c) => (c + 1) % testCommandCandidates.length);
      } else if (input === ' ') {
        const command = testCommandCandidates[testCommandCursor]?.command;
        if (command !== undefined) {
          setTestCommandSelected((prev) => {
            const next = new Set(prev);
            if (next.has(command)) next.delete(command);
            else next.add(command);
            return next;
          });
        }
      }
      return;
    }

    // Convergence selection.
    if (pendingConvergence) {
      const { req, resolve } = pendingConvergence;
      const count = req.branches.length;
      if (key.upArrow || input === 'k') setConvCursor((c) => (c + count - 1) % count);
      else if (key.downArrow || input === 'j') setConvCursor((c) => (c + 1) % count);
      else if (input === ' ') {
        const id = req.branches[convCursor]!.instanceId;
        setConvSelected((prev) => {
          const next = req.mode === 'compare' ? new Set<string>() : new Set(prev);
          if (prev.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else if (key.return) {
        const selected = [...convSelected];
        const valid =
          req.mode === 'compare' ? selected.length === 1 : selected.length >= 1;
        if (valid) resolve(selected);
      }
      return;
    }

    // Approval gate: keyboard-first approve/reject. Scoped to the gate being
    // the focused node, same as Discuss above — tabbing away must reach the
    // node you tabbed to instead of a/r still landing on a gate you can no
    // longer see.
    if (pendingApprovalPanelOpen && pendingApproval) {
      if (input === 'a') {
        pendingApproval.resolve('approve');
        return;
      }
      if (input === 'r') {
        pendingApproval.resolve('reject');
        return;
      }
      if (input === 'j' || key.downArrow) setDiffScroll((s) => s + 1);
      if (input === 'k' || key.upArrow) setDiffScroll((s) => Math.max(0, s - 1));
      if (key.pageDown) setDiffScroll((s) => s + diffPageStep);
      if (key.pageUp) setDiffScroll((s) => Math.max(0, s - diffPageStep));
      // Shift-tab steps back, as it does everywhere else. Ink reports it as
      // `tab` with `shift` set, so a bare `key.tab` here sent it forwards —
      // the one panel where tabbing back to re-read an upstream node was a
      // full lap around the graph.
      if (key.tab) {
        setFocusIdx((i) => (i + (key.shift ? workflow.order.length - 1 : 1)) % workflow.order.length);
      }
      return;
    }

    // The key map (`?`). It owns the keyboard while it is up, so the arrows
    // scroll it rather than panning a canvas nobody can see — and every key
    // that plausibly means "get me out of here" closes it, `q` included:
    // quitting the run outright is not what that means on a help screen.
    if (helpOpen) {
      if (key.escape || key.return || input === '?' || input === 'q') {
        setHelpOpen(false);
        return;
      }
      if (key.upArrow || input === 'k') setHelpScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === 'j') setHelpScroll((s) => Math.min(helpMaxScroll, s + 1));
      else if (key.pageUp) setHelpScroll((s) => Math.max(0, s - helpVisible));
      else if (key.pageDown) setHelpScroll((s) => Math.min(helpMaxScroll, s + helpVisible));
      return;
    }

    // Model picker: only reachable (via `m` below) when none of the modes
    // above are active, so this can never collide with them.
    if (pickerOpen && focusedNode) {
      if (key.escape) {
        closeNodePanel();
        return;
      }
      if (pickerFreeText !== null) {
        if (key.return) {
          const text = pickerFreeText.trim();
          closeNodePanel();
          if (text.length > 0) confirmModel(focusedNode.id, text);
          return;
        }
        const editedModel = applyLineEdit(pickerFreeText, input, key);
        if (editedModel !== null) {
          setPickerFreeText(editedModel);
          return;
        }
        if (key.backspace || key.delete) {
          setPickerFreeText((b) => (b ?? '').slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
          setPickerFreeText((b) => (b ?? '') + input);
        }
        return;
      }
      if (pickerModelListState?.status !== 'loaded') return; // loading, or failed and about to flip to free-text
      const models = pickerModelListState.models;
      if (models.length === 0) return;
      if (key.upArrow || input === 'k') setPickerCursor((c) => (c + models.length - 1) % models.length);
      else if (key.downArrow || input === 'j') setPickerCursor((c) => (c + 1) % models.length);
      else if (key.return) {
        closeNodePanel();
        confirmModel(focusedNode.id, models[pickerCursor]!);
      }
      return;
    }

    // Node settings editor. Two modes: moving between fields, and typing into
    // one. Enter switches between them — it opens the field under the cursor
    // and, on the second press, saves it — so there is no separate "edit" key
    // to learn and no way to be typing without seeing a cursor.
    if (editorOpen && focusedNode && editorField) {
      if (key.escape) {
        // Escape backs out of the field being typed, then out of the panel:
        // an abandoned edit shouldn't cost you the panel too.
        if (editorBuffer !== null) setEditorBuffer(null);
        else closeNodePanel();
        return;
      }
      if (editorBuffer === null) {
        if (key.upArrow || input === 'k') {
          setEditorCursor((c) => (c + editorFields.length - 1) % editorFields.length);
        } else if (key.downArrow || input === 'j') {
          setEditorCursor((c) => (c + 1) % editorFields.length);
        } else if (key.return) {
          setEditorBuffer(editorField.value);
        } else if (input === 'm' || input === 's') {
          // This panel's footer has always offered `m`/`s` as a way across to
          // the other two per-node panels, and nothing implemented them —
          // the settings editor swallowed both. Switch, rather than stack:
          // all three edit the same node, and only one panel is ever up. A
          // picker that declines (no model field, no skills) leaves the
          // settings panel where it was, so the explanation has something to
          // be an explanation *of*.
          const opened =
            input === 'm' ? openModelPicker(focusedNode.id) : openSkillPicker(focusedNode.id);
          if (opened) setEditorOpen(false);
        }
        return;
      }
      if (key.return) {
        commitEditorField(focusedNode.id, editorField, editorBuffer);
        return;
      }
      const editedField = applyLineEdit(editorBuffer, input, key);
      if (editedField !== null) {
        setEditorBuffer(editedField);
        return;
      }
      if (key.backspace || key.delete) {
        setEditorBuffer((b) => (b ?? '').slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
        setEditorBuffer((b) => (b ?? '') + input);
      }
      return;
    }

    // Skill picker: same reachable-only-via-`s` guarantee as the model picker
    // above. Multi-select, so enter confirms the whole set rather than one
    // item. Typing filters the catalog by id/description, so j/k aren't
    // navigation aliases here the way they are elsewhere — a typed "j" is
    // query text, not a keystroke; only the arrows move the cursor.
    if (skillPickerOpen && focusedNode) {
      if (key.escape) {
        // Backs out of the query first, then the panel — same shape as the
        // node-settings editor's escape handling below.
        if (skillPickerQuery) {
          setSkillPickerQuery('');
          return;
        }
        closeNodePanel();
        return;
      }
      if (key.return) {
        closeNodePanel();
        confirmSkills(focusedNode.id, skillPickerSelected);
        return;
      }
      if (skillCatalog.length === 0) return;
      if (key.upArrow) {
        if (filteredSkillCatalog.length > 0) {
          setSkillPickerCursor((c) => (c + filteredSkillCatalog.length - 1) % filteredSkillCatalog.length);
        }
        return;
      }
      if (key.downArrow) {
        if (filteredSkillCatalog.length > 0) {
          setSkillPickerCursor((c) => (c + 1) % filteredSkillCatalog.length);
        }
        return;
      }
      if (input === ' ') {
        const skill = filteredSkillCatalog[skillPickerCursor];
        if (skill) {
          setSkillPickerSelected((prev) => {
            const next = new Set(prev);
            if (next.has(skill.id)) next.delete(skill.id);
            else next.add(skill.id);
            return next;
          });
        }
        return;
      }
      const editedQuery = applyLineEdit(skillPickerQuery, input, key);
      if (editedQuery !== null) {
        setSkillPickerQuery(editedQuery);
        return;
      }
      if (key.backspace || key.delete) {
        setSkillPickerQuery((q) => q.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
        setSkillPickerQuery((q) => q + input);
      }
      return;
    }

    // Approval gate replay: j/k scrolls the persisted diff, same as the live
    // panel. Falls through (no early return for other keys) so enter/tab
    // still close the panel / move focus via normal navigation below.
    if (expanded && focusedNode?.type.id === 'approval-gate') {
      const output = runState.nodes[focusedNode.id]?.output as { diffs?: unknown } | undefined;
      if (Array.isArray(output?.diffs)) {
        if (input === 'j' || key.downArrow) {
          setDiffScroll((s) => s + 1);
          return;
        }
        if (input === 'k' || key.upArrow) {
          setDiffScroll((s) => Math.max(0, s - 1));
          return;
        }
        if (key.pageDown) {
          setDiffScroll((s) => s + diffPageStep);
          return;
        }
        if (key.pageUp) {
          setDiffScroll((s) => Math.max(0, s - diffPageStep));
          return;
        }
      }
    }

    // Default node panel (agent output above, activity log below): PageUp/
    // PageDown scrolls the activity log — usually the longer, more-current
    // stream — and shift+PageUp/PageDown scrolls the agent output above it.
    // Falls through so enter/tab still work; excludes the approval-gate
    // replay above, which has its own diff scroll.
    if (expanded && focusedNode && !nodePanelIsDiffReplay) {
      if (key.pageUp) {
        if (key.shift) {
          setOutputPin(pinAfterScroll(outputWindow, Math.max(1, nodePanelOutputBudget - 1)));
        } else {
          setActivityPin(pinAfterScroll(activityWindow, Math.max(1, nodePanelActivityBudget - 1)));
        }
        return;
      }
      if (key.pageDown) {
        if (key.shift) {
          setOutputPin(pinAfterScroll(outputWindow, -Math.max(1, nodePanelOutputBudget - 1)));
        } else {
          setActivityPin(pinAfterScroll(activityWindow, -Math.max(1, nodePanelActivityBudget - 1)));
        }
        return;
      }
    }

    // Normal navigation.
    if (key.escape) {
      // Every other panel closes on escape. The node-detail panel — the one
      // you are most likely to be sitting in, since `enter` opens it — was
      // the exception, so escaping out of a diff you had finished reading did
      // nothing whatsoever.
      if (expanded) setExpanded(false);
    } else if (input === '?') {
      // The full key map. The hint line below can only ever advertise the
      // first handful, and a docked panel replaces it outright.
      setHelpScroll(0);
      setHelpOpen(true);
    } else if (key.tab && key.shift) {
      setFocusIdx((i) => (i + workflow.order.length - 1) % workflow.order.length);
    } else if (key.tab) {
      setFocusIdx((i) => (i + 1) % workflow.order.length);
    } else if (key.return) {
      setExpanded((e) => !e);
    } else if (input === 'm') {
      if (focusedNode) openModelPicker(focusedNode.id);
    } else if (input === 's') {
      if (focusedNode) openSkillPicker(focusedNode.id);
    } else if (input === 'e') {
      if (focusedNode) openEditor(focusedNode.id);
    } else if (input === 'z') {
      // One step along the zoom axis: full ←→ compact, and out of mini into
      // compact rather than jumping two stops at once.
      zoomBy(zoom === 1 ? -1 : 1);
    } else if (input === 'o') {
      // Jump to the far end and back. Returning restores the zoom you left —
      // including "follow the auto rule" if you never set one.
      if (zoom === MAX_ZOOM) {
        setZoomOverride(zoomBeforeMiniRef.current);
        zoomBeforeMiniRef.current = null;
      } else {
        zoomBeforeMiniRef.current = zoomOverride;
        setZoomOverride(MAX_ZOOM);
      }
    } else if (input === 'c') {
      setCamera((m) => (m === 'center' ? 'nudge' : 'center'));
    } else if (input === 'w') {
      setWrapEnabled((w) => !w);
    } else if (key.leftArrow) {
      panBy(-PAN_STEP_X, 0);
    } else if (key.rightArrow) {
      panBy(PAN_STEP_X, 0);
    } else if (key.upArrow) {
      panBy(0, -PAN_STEP_Y);
    } else if (key.downArrow) {
      panBy(0, PAN_STEP_Y);
    } else if (input === 'q') {
      onExit();
      exit();
    }
  });

  const grid = useMemo(
    // modelTick isn't read inside renderGraph — it's a dependency purely to
    // force recomputation, since confirmModel mutates a node's config field
    // on the same `workflow` object in place rather than replacing it, so
    // `workflow`'s own identity never changes for this memo to key off.
    // `frame` plays the same role for the animated parts of a node card.
    () => renderGraph(workflow, layout, runState, focusedId, { frame, now: Date.now() }),
    [workflow, layout, runState, focusedId, modelTick, frame],
  );
  const canvasLines = useMemo(
    () => gridToLines(grid, { ...offset, width: canvasWidth, height: canvasHeight }),
    [grid, offset, canvasWidth, canvasHeight],
  );

  const statusCounts = Object.values(runState.nodes).reduce<Partial<Record<NodeStatus, number>>>(
    (acc, n) => {
      acc[n.status] = (acc[n.status] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const finished = runState.finishedAt !== undefined;
  const runTokens = totalTokens(runState.nodes);
  // Fixed lifecycle order, not whatever order the statuses first appeared in.
  // Reading the record's own key order put the segments wherever the first
  // node to reach each status happened to sit, so `● 3` and `◐ 1` swapped
  // places as the run moved — the header's most-watched number changing
  // position underneath the eye watching it.
  const headerParts = STATUS_ORDER.filter((status) => statusCounts[status] !== undefined).map(
    (status) => `${STATUS_GLYPHS[status]} ${statusCounts[status]}`,
  );

  // Watch-mode header. Both facts are pure functions of the state just
  // applied, so they re-derive on every snapshot with no extra plumbing
  // between the watcher and this component.
  const watchAttached = watch && isAttached(runState);
  // A run that ended is not "stale" — it has no driver because it's over.
  // Three-valued deliberately: a run written on another machine cannot be
  // called gone, and saying so about a live run is the failure this header
  // exists to prevent.
  // A run driven from someone else's session never has an identifiable driver
  // — the session doing the work is one flow-code cannot see — so "driver
  // unknown" would sit on every healthy one of them and mean nothing. True at
  // either non-engine tier, so it keys off that rather than off one of them.
  // The run's own tier line already says what its contents rest on.
  const liveness =
    watchAttached && !finished && tier === 'engine' ? driverLiveness(runState) : 'live';
  const driverGone = liveness === 'dead';
  const driverUnknown = liveness === 'unknown';
  const runLabel = watch
    ? watchAttached
      ? `watching ${runState.runId.slice(0, 8)}`
      : 'waiting for a run'
    : `run ${runState.runId.slice(0, 8)}`;
  // Which named graph this run selected, when the file declared more than
  // one — legible without comparing the graph on screen to the file.
  const selectedGraph = runState.graph?.selected;

  // Docked panels stay in normal flow (as before); a floating one is drawn
  // absolutely-positioned on top of the canvas, at whatever rect the user
  // last dragged/resized it to. Spread onto whichever panel variant is open.
  const panelBoxProps = {
    flexDirection: 'column',
    borderStyle: 'round',
    // Lights up the whole frame while it's being dragged.
    borderColor: panelDragMode ? 'cyan' : undefined,
    paddingX: 1,
    ...(floating
      ? ({
          position: 'absolute',
          left: activeRect.x,
          top: activeRect.y,
          width: activeRect.w,
          height: activeRect.h,
        } as const)
      : { height: panelHeight }),
  } as const;
  // Ink only paints a Box's own border and its children's actual text — an
  // absolutely-positioned panel gets no implicit background, so any row or
  // column its content doesn't reach (a short line, unfilled height) leaves
  // whatever the canvas painted underneath showing through the gap. A docked
  // panel doesn't need this: it sits in normal flow, so nothing else is
  // drawn at its rows in the first place. Plain spaces (no color) blank the
  // gap without imposing a background the terminal's own theme doesn't have;
  // painted first, every real content line drawn afterward lands on top of it.
  const panelBackdrop = floating ? (
    <Box position="absolute" top={0} left={0}>
      <Text>
        {Array.from({ length: Math.max(0, activeRect.h - 2) }, () =>
          ' '.repeat(Math.max(0, activeRect.w - 2)),
        ).join('\n')}
      </Text>
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* truncate, never wrap: HEADER_ROWS budgets exactly one row for this,
          and a second one pushes the whole frame past `rows`, at which point
          the terminal scrolls and the header is drawn over the canvas. */}
      <Text wrap="truncate-end">
        <Text bold color="cyan">
          flow-code
        </Text>
        <Text dimColor> {runLabel}</Text>
        {selectedGraph ? <Text dimColor> ({selectedGraph})</Text> : null}
        {/* Directly behind the run's own name, ahead of every standing
            signal: this is the answer to the key just pressed, and it used to
            sit last on a row that truncates — so on any terminal narrow
            enough to need the explanation, the explanation was the first
            thing cut. It clears itself after a few seconds. */}
        {pickerMessage ? <Text color="yellow"> · {pickerMessage}</Text> : null}
        <Text dimColor> · </Text>
        <Text>{headerParts.join('  ')}</Text>
        {tier !== 'engine' ? <Text color="yellow"> · {TIER_LABELS[tier]}</Text> : null}
        {/* A tier with no token accounting did not spend nothing — nothing
            counted. Blanking the segment would read as "cheap"; `n/a` reads as
            what it is. Engine runs keep the old behaviour exactly: a real
            count when there is one, and no segment before the first token. */}
        {runTokens > 0 ? (
          <Text color="cyan"> · {formatTokens(runTokens)} tok</Text>
        ) : tier !== 'engine' ? (
          <Text dimColor> · spend n/a</Text>
        ) : null}
        {/* Sits beside the token count because both answer "what is this run
            costing" — but this one is the provider's own accounting of the
            plan window, so it stays true however many sessions a node runs. */}
        {rateLimitSegments(runState.rateLimits).map((segment) => (
          <Text key={segment.id} color={RATE_LIMIT_COLORS[segment.tone]}>
            {' '}
            · {segment.text}
          </Text>
        ))}
        {driverGone ? <Text color="yellow"> · driver gone</Text> : null}
        {driverUnknown ? <Text color="yellow"> · driver unknown</Text> : null}
        {/* Named rather than counted: "2 nodes disagree" sends someone hunting
            through the graph for which, and the whole value of the finding is
            knowing where to look. */}
        {reconcileFindings.length > 0 ? (
          <Text color="red"> · tree disagrees: {reconcileFindings.join(', ')}</Text>
        ) : null}
        {graphIssue ? <Text color="yellow"> · {graphIssue}</Text> : null}
        {finished ? <Text color="green"> · finished — press q to exit</Text> : null}
        {/* Lives in the header rather than the bottom hint line because the
            hint line disappears behind a docked panel — which is exactly when
            the canvas is smallest and the most nodes are off-screen. */}
        {/* Which node has focus is state, not a keybinding, and it is most
            worth knowing while a panel covers the canvas — so it belongs here
            rather than on the hint line, which that panel replaces. */}
        {focusedNode ? <Text dimColor> · focused: {focusedNode.id}</Text> : null}
        {density !== 'full' ? (
          <Text dimColor> · {density === 'mini' ? 'overview' : 'compact'}</Text>
        ) : null}
        {camera === 'nudge' ? <Text dimColor> · free camera</Text> : null}
        {!wrapEnabled ? <Text dimColor> · wrap off</Text> : null}
        {offscreenHint ? <Text dimColor> · {offscreenHint} off-screen (⇧+arrows)</Text> : null}
        {floating ? <Text dimColor> · ctrl+p: dock panel</Text> : null}
      </Text>
      {tierLine ? (
        <Text color="yellow" wrap="truncate-end">
          {tierLine}
        </Text>
      ) : null}
      <Box flexDirection="column" height={canvasHeight}>
        {canvasLines.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
      {discussPanelOpen && discussState ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Discussion — {discussState.nodeId}
              {discussState.topic ? `: ${discussState.topic}` : ''}
              {!discussWindow.following ? (
                <Text dimColor>
                  {' '}
                  ({discussWindow.start} above
                  {discussRows.length - discussWindow.end > 0
                    ? `, ${discussRows.length - discussWindow.end} below`
                    : ''}
                  )
                </Text>
              ) : null}
            </Text>
          </PanelTitle>
          {/* Grows to fill the panel; text starts at the top and the footer
              keeps its grip in the corner. */}
          <Box flexDirection="column" flexGrow={1} justifyContent="flex-start" overflow="hidden">
            {discussRows.slice(discussWindow.start, discussWindow.end).map((row) => (
              <Text key={row.key} wrap="truncate-end">
                <Text color={row.color}>{row.prefix}</Text>
                {row.segments.map((segment, i) => (
                  <Text key={i} {...segmentStyle(segment)}>
                    {segment.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
          {discussState.awaitingUser ? (
            <Box flexDirection="column">
              {discussState.options?.map((option, i) => (
                <Text
                  key={i}
                  wrap="truncate-end"
                  {...(i === discussOptionCursor ? { color: 'cyan', bold: true } : {})}
                >
                  {i === discussOptionCursor ? '❯ ' : '  '}
                  {option}
                </Text>
              ))}
              <Text wrap="truncate-end">
                <Text color="cyan">{'> '}</Text>
                {/* Show the tail of a long line so the caret stays on screen. */}
                {inputBuffer.slice(Math.max(0, inputBuffer.length - discussInputWidth))}
                <Text inverse> </Text>
              </Text>
              {/* How to get *out* of a discussion, on its own row directly under
                  the caret. The footer already says it, but the footer is dim,
                  truncates first on a narrow panel, and is the last place a
                  reader looks. A discussion ends only when the user says so, so
                  the way to say so has to sit where they are typing. The draft
                  case is spelled out too: with text in the box escape clears the
                  draft, and a user who pressed it once and saw the panel stay
                  put has no way to know that was the intent. */}
              <Text wrap="truncate-end">
                <Text color="cyan">esc</Text>
                <Text dimColor>
                  {inputBuffer.length > 0
                    ? ': clear draft · /done: finish the discussion'
                    : ' or /done: finish the discussion'}
                </Text>
              </Text>
            </Box>
          ) : (
            <Text dimColor>
              {spinnerFrame(frame)} agent is thinking{ellipsis(frame)}
            </Text>
          )}
          {/* No escape hint down here: the row above the caret already carries
              it, and saying it twice costs a transcript row the docked panel
              cannot spare (MIN_PANEL_HEIGHT is 8, and options eat a row each).
              The footer keeps what the input area does not mention. */}
          <PanelFooter
            hint={
              !discussState.awaitingUser
                ? 'tab: other nodes · PgUp/PgDn: scroll'
                : discussState.options && discussState.options.length > 0
                  ? '↑/↓: choose · enter: select · or type an answer'
                  : 'enter: send · tab: other nodes · PgUp/PgDn: scroll'
            }
          />
        </Box>
      ) : pendingTestCommands ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Test commands — {pendingTestCommands.req.nodeId}
            </Text>
          </PanelTitle>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              This node has never been told what to run. Whatever you pick is saved to
              .flow-code/workflow.yaml.
            </Text>
            {testCommandCandidates.length === 0 && !pendingTestCommands.discovering ? (
              <Text dimColor wrap="truncate-end">
                nothing detected by inspection — `d` to have flow-code read the repo, `a` to type one
              </Text>
            ) : null}
            {testCommandCandidates.map((candidate, i) => (
              <Text key={candidate.command} wrap="truncate-end">
                <Text {...(i === testCommandCursor ? { color: 'cyan' } : {})}>
                  {i === testCommandCursor ? '❯ ' : '  '}
                  {testCommandSelected.has(candidate.command) ? '[x] ' : '[ ] '}
                  {candidate.command}{' '}
                </Text>
                <Text dimColor>{candidate.note}</Text>
              </Text>
            ))}
            {pendingTestCommands.discovering ? (
              <Text color="cyan" wrap="truncate-end">
                reading the repository…
              </Text>
            ) : null}
            {pendingTestCommands.discoverError ? (
              <Text color="red" wrap="truncate-end">
                could not work it out: {pendingTestCommands.discoverError}
              </Text>
            ) : null}
            {testCommandInput !== null ? (
              <Text wrap="truncate-end">command: {testCommandInput}▌</Text>
            ) : null}
          </Box>
          <PanelFooter
            hint={
              testCommandInput !== null
                ? 'enter: add · esc: cancel'
                : 'space: select · enter: confirm · a: add · d: detect · esc: skip'
            }
          />
        </Box>
      ) : pendingConvergence ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Convergence — {pendingConvergence.req.nodeId} ({pendingConvergence.req.mode}
              {pendingConvergence.req.mode === 'compare'
                ? ': pick exactly one'
                : ': pick one or more'}
              )
            </Text>
          </PanelTitle>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {pendingConvergence.req.branches.map((branch, i) => (
              <Text key={branch.instanceId} wrap="truncate-end">
                <Text {...(i === convCursor ? { color: 'cyan' } : {})}>
                  {i === convCursor ? '❯ ' : '  '}
                  {convSelected.has(branch.instanceId) ? '[x] ' : '[ ] '}
                  {branch.instanceId} ({branch.branch}) {branch.status === 'done' ? '●' : '✖'}{' '}
                </Text>
                <Text dimColor>{branch.diffSummary.split('\n').at(-1) ?? ''}</Text>
              </Text>
            ))}
          </Box>
          <PanelFooter hint="↑/↓: move · space: select · enter: confirm" />
        </Box>
      ) : pendingApprovalPanelOpen && pendingApproval ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Approval — {pendingApproval.req.title}
            </Text>
          </PanelTitle>
          {pendingApproval.req.pushTarget ? (
            <Text color="red">
              On approval, `{pendingApproval.req.pushTarget.nodeId}` will push to{' '}
              {pendingApproval.req.pushTarget.remote}/{pendingApproval.req.pushTarget.branch}
            </Text>
          ) : null}
          <Text dimColor>
            upstream: {pendingApproval.req.upstreamSummaries.map((u) => u.nodeId).join(', ') || '—'}
          </Text>
          {(() => {
            if (!pendingApproval.req.agentSummary) return null;
            // Capped to a fixed number of lines (not fully dynamic) so a long
            // critique can't silently eat the diff's viewport the way an
            // uncapped variable-height block did for the skill picker's
            // search line earlier — see `visible` below, which reserves
            // exactly this many rows plus one for the label.
            const summaryLines = wrapText(
              pendingApproval.req.agentSummary,
              Math.max(10, Math.min(activeRect.w - 4, MAX_PROSE_WIDTH)),
            ).slice(0, 4);
            return (
              <Box flexDirection="column">
                <Text color="magenta" bold>
                  AI critique (from attached skill/instructions):
                </Text>
                {summaryLines.map((line, i) => (
                  <Text key={i} dimColor wrap="truncate-end">
                    {line || ' '}
                  </Text>
                ))}
              </Box>
            );
          })()}
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {(() => {
              const lines = diffLinesFor(pendingApproval.req.diffs);
              const summaryBudget = pendingApproval.req.agentSummary
                ? Math.min(
                    4,
                    wrapText(
                      pendingApproval.req.agentSummary,
                      Math.max(10, Math.min(activeRect.w - 4, MAX_PROSE_WIDTH)),
                    ).length,
                  ) + 1
                : 0;
              const visible = Math.max(1, panelHeight - 6 - summaryBudget);
              const start = Math.min(diffScroll, Math.max(0, lines.length - visible));
              return <DiffLines lines={lines} start={start} visible={visible} />;
            })()}
          </Box>
          <PanelFooter hint="[a] approve · [r] reject · PgUp/PgDn: scroll diff" />
        </Box>
      ) : helpOpen ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Keys
              {helpMaxScroll > 0 ? (
                <Text dimColor>
                  {' '}
                  ({helpStart} above
                  {helpAllRows.length - helpStart - helpVisible > 0
                    ? `, ${helpAllRows.length - helpStart - helpVisible} below`
                    : ''}
                  )
                </Text>
              ) : null}
            </Text>
          </PanelTitle>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {helpAllRows.slice(helpStart, helpStart + helpVisible).map((row, i) => {
              if (row.kind === 'blank') return <Text key={i}> </Text>;
              if (row.kind === 'title') {
                return (
                  <Text key={i} bold wrap="truncate-end">
                    {row.text}
                  </Text>
                );
              }
              return (
                <Text key={i} wrap="truncate-end">
                  <Text color="cyan">{`  ${row.keys.padEnd(helpColumnWidth)}`}</Text>
                  <Text dimColor>{`  ${row.what}`}</Text>
                </Text>
              );
            })}
          </Box>
          <PanelFooter hint="↑/↓/PgUp/PgDn: scroll · ?/esc: close" />
        </Box>
      ) : pickerOpen && focusedNode ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Model — {focusedNode.id} ({focusedNode.type.displayName})
            </Text>
          </PanelTitle>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {(() => {
              const status = runState.nodes[focusedNode.id]?.status;
              const readOnly = status === 'running' || status === 'done';
              return (
                <>
                  {readOnly ? (
                    <Text color="yellow" wrap="truncate-end">
                      {focusedNode.id} is already {status} — a change here applies the next time it
                      runs, not to {status === 'running' ? 'the session in flight' : 'this attempt'}.
                    </Text>
                  ) : null}
                  {pickerFreeText !== null ? (
                    <>
                      <Text dimColor wrap="truncate-end">
                        model list unavailable
                        {pickerModelListState?.status === 'failed' ? `: ${pickerModelListState.error}` : ''}
                        {' — type a model id'}
                      </Text>
                      <Text wrap="truncate-end">
                        <Text color="cyan">{'> '}</Text>
                        {pickerFreeText}
                        <Text inverse> </Text>
                      </Text>
                    </>
                  ) : pickerModelListState?.status === 'loaded' ? (
                    (() => {
                      const models = pickerModelListState.models;
                      const { start, end } = windowFor(pickerCursor, models.length, 10);
                      return (
                        <>
                          {start > 0 ? <Text dimColor> ↑ {start} more above</Text> : null}
                          {models.slice(start, end).map((model, i) => {
                            const idx = start + i;
                            const current = model === focusedNodeResolvedModel?.model;
                            return (
                              <Text
                                key={model}
                                wrap="truncate-end"
                                {...(idx === pickerCursor ? { color: 'cyan', bold: true } : {})}
                              >
                                {idx === pickerCursor ? '❯ ' : '  '}
                                {current ? '● ' : '  '}
                                {model}
                              </Text>
                            );
                          })}
                          {end < models.length ? (
                            <Text dimColor> ↓ {models.length - end} more below</Text>
                          ) : null}
                        </>
                      );
                    })()
                  ) : (
                    <Text dimColor>loading models…</Text>
                  )}
                </>
              );
            })()}
          </Box>
          <PanelFooter
            hint={
              pickerFreeText !== null
                ? 'enter: confirm · esc: cancel'
                : '↑/↓: move · enter: select · esc: cancel'
            }
          />
        </Box>
      ) : skillPickerOpen && focusedNode ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Skills — {focusedNode.id} ({focusedNode.type.displayName})
            </Text>
          </PanelTitle>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {(() => {
              const status = runState.nodes[focusedNode.id]?.status;
              const readOnly = status === 'running' || status === 'done';
              return (
                <>
                  {readOnly ? (
                    <Text color="yellow" wrap="truncate-end">
                      {focusedNode.id} is already {status} — a change here applies the next time it
                      runs, not to {status === 'running' ? 'the session in flight' : 'this attempt'}.
                    </Text>
                  ) : null}
                  {skillCatalog.length === 0 ? (
                    <Text dimColor wrap="truncate-end">
                      no skills discovered — see `flow-code skills`.
                    </Text>
                  ) : (
                    <>
                      <Text wrap="truncate-end">
                        <Text dimColor>search: </Text>
                        {skillPickerQuery}
                        <Text inverse> </Text>
                      </Text>
                      {filteredSkillCatalog.length === 0 ? (
                        <Text dimColor wrap="truncate-end">
                          no skill matches "{skillPickerQuery}"
                        </Text>
                      ) : (
                        (() => {
                          // Borders, title, the search line, footer, and
                          // (worst case) both scroll indicators — a fixed
                          // window size taller than what's actually left
                          // over would silently drop rows rather than
                          // resize, on a short terminal or a very large
                          // catalog (a plugin marketplace easily has
                          // hundreds of skills).
                          const skillListBudget = Math.max(3, panelHeight - 7);
                          const { start, end } = windowFor(skillPickerCursor, filteredSkillCatalog.length, skillListBudget);
                          return (
                            <>
                              {start > 0 ? <Text dimColor> ↑ {start} more above</Text> : null}
                              {filteredSkillCatalog.slice(start, end).map((skill, i) => {
                                const idx = start + i;
                                const checked = skillPickerSelected.has(skill.id);
                                return (
                                  <Text
                                    key={skill.id}
                                    wrap="truncate-end"
                                    {...(idx === skillPickerCursor ? { color: 'cyan', bold: true } : {})}
                                  >
                                    {idx === skillPickerCursor ? '❯ ' : '  '}
                                    {checked ? '[x] ' : '[ ] '}
                                    {skill.id}
                                  </Text>
                                );
                              })}
                              {end < filteredSkillCatalog.length ? (
                                <Text dimColor> ↓ {filteredSkillCatalog.length - end} more below</Text>
                              ) : null}
                            </>
                          );
                        })()
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </Box>
          <PanelFooter hint="type: filter · ↑/↓: move · space: toggle · enter: confirm · esc: cancel" />
        </Box>
      ) : editorOpen && focusedNode ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          <PanelTitle>
            <Text bold color="yellow" wrap="truncate-end">
              Settings — {focusedNode.id} ({focusedNode.type.displayName})
            </Text>
          </PanelTitle>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {(() => {
              const status = runState.nodes[focusedNode.id]?.status;
              const readOnly = status === 'running' || status === 'done';
              return (
                <>
                  {readOnly ? (
                    <Text color="yellow" wrap="truncate-end">
                      {focusedNode.id} is already {status} — a change here applies the next time it
                      runs, not to {status === 'running' ? 'the session in flight' : 'this attempt'}.
                    </Text>
                  ) : null}
                  {editorFields.map((field, idx) => {
                    const active = idx === editorCursor;
                    const typing = active && editorBuffer !== null;
                    const shown = typing ? `${editorBuffer}▌` : field.value;
                    return (
                      <Text
                        key={field.key}
                        wrap="truncate-end"
                        {...(active ? { color: 'cyan', bold: true } : {})}
                      >
                        {active ? '❯ ' : '  '}
                        {field.label}: {shown.length > 0 ? shown : <Text dimColor>{field.placeholder}</Text>}
                      </Text>
                    );
                  })}
                </>
              );
            })()}
          </Box>
          <PanelFooter
            hint={
              editorBuffer !== null
                ? 'type a value · empty clears it · enter: save · esc: cancel'
                : '↑/↓: move · enter: edit · m: model · s: skills · esc: close'
            }
          />
        </Box>
      ) : expanded && focusedNode ? (
        <Box {...panelBoxProps}>
          {panelBackdrop}
          {(() => {
            const state = runState.nodes[focusedNode.id]!;
            // A decided approval gate has nothing else worth showing here —
            // replay the same green/red diff the live panel showed, instead
            // of the generic (and for this node type, nearly empty) view.
            if (focusedNode.type.id === 'approval-gate') {
              const output = state.output as
                | { decision?: string; diffs?: Array<{ label?: string; diff: string }> }
                | undefined;
              if (Array.isArray(output?.diffs)) {
                const lines = diffLinesFor(output.diffs);
                const visible = Math.max(1, panelHeight - 4);
                const start = Math.min(diffScroll, Math.max(0, lines.length - visible));
                return (
                  <>
                    <PanelTitle>
                      <Text bold wrap="truncate-end">
                        {focusedNode.id} <Text dimColor>({focusedNode.type.displayName})</Text>{' '}
                        {/* A rejection completes the node, so the status glyph
                            alone would read as a success. The decision decides
                            the glyph here, not the status. */}
                        {output?.decision === 'approved'
                          ? `${STATUS_GLYPHS[state.status]} approved`
                          : `${STATUS_GLYPHS.error} rejected`}
                      </Text>
                    </PanelTitle>
                    <Box flexDirection="column" flexGrow={1} overflow="hidden">
                      <DiffLines lines={lines} start={start} visible={visible} />
                    </Box>
                    <PanelFooter hint="PgUp/PgDn: scroll diff · enter/esc: close · tab: focus" />
                  </>
                );
              }
            }
            // activity/liveLines and their scroll windows are hoisted above
            // (nodePanelActivity, nodePanelLiveLines, outputWindow,
            // activityWindow) so the keyboard/mouse handlers can reach them.
            return (
              <>
                <PanelTitle>
                  <Text bold wrap="truncate-end">
                    {focusedNode.id} <Text dimColor>({focusedNode.type.displayName})</Text>{' '}
                    {STATUS_GLYPHS[state.status]} {state.status}
                    {state.statusDetail ? <Text dimColor> — {state.statusDetail}</Text> : null}
                    {state.denials > 0 ? (
                      <Text color="red" bold>
                        {'  '}⚠ {state.denials} blocked action{state.denials > 1 ? 's' : ''}
                      </Text>
                    ) : null}
                  </Text>
                </PanelTitle>
                <Box flexDirection="column" flexGrow={1} overflow="hidden">
                  {Object.entries((focusedNode.config as Record<string, unknown> | null) ?? {})
                    .filter(([key]) => key !== 'model' && key !== 'skills')
                    .map(([key, value]) => (
                      <Text key={key} dimColor wrap="truncate-end">
                        {key}: {formatConfigValue(value)}
                      </Text>
                    ))}
                  {focusedNode.type.hasModelField ? (
                    <Text dimColor wrap="truncate-end">
                      model: {focusedNodeResolvedModel?.model ?? '(none — provider default)'}
                      {focusedNodeResolvedModel
                        ? ` (from ${
                            { node: 'this node', settings: 'run settings', provider: 'provider default' }[
                              focusedNodeResolvedModel.origin
                            ]
                          }) · m: change`
                        : ''}
                    </Text>
                  ) : null}
                  {nodeTypeAcceptsAgentStep(focusedNode.type) ? (
                    <Text dimColor wrap="truncate-end">
                      skills: {focusedNode.skills.length > 0 ? focusedNode.skills.map((s) => s.id).join(', ') : '(none)'} · s: change
                    </Text>
                  ) : null}
                  {/* The canvas badge names one end and counts the rest; this
                      is where the rest get named, along with the attempt
                      budget that has nowhere to live on a card. */}
                  {focusedLoops.length > 0 ? (
                    <Text color="magenta" wrap="truncate-end">
                      loops: {focusedLoops.join(' · ')}
                    </Text>
                  ) : null}
                  {state.tokens || state.startedAt ? (
                    <Text dimColor wrap="truncate-end">
                      {state.tokens
                        ? `tokens: ${formatTokens(state.tokens.input)} in` +
                          ` · ${formatTokens(state.tokens.output)} out` +
                          // Split out because the budget treats them differently:
                          // writes count against it, reads never do.
                          (cacheWriteTokens(state.tokens) > 0
                            ? ` · ${formatTokens(cacheWriteTokens(state.tokens))} cache write`
                            : '') +
                          (cacheReadTokens(state.tokens) > 0
                            ? ` · ${formatTokens(cacheReadTokens(state.tokens))} cached (unbudgeted)`
                            : '')
                        : 'tokens: —'}
                      {state.startedAt
                        ? ` · elapsed ${formatDuration(
                            (state.endedAt ? Date.parse(state.endedAt) : Date.now()) -
                              Date.parse(state.startedAt),
                          )}`
                        : ''}
                    </Text>
                  ) : null}
                  {(state.priorAttempts?.length ?? 0) > 0 ? (
                    <Text color="magenta" wrap="truncate-end">
                      attempt {state.attempt ?? 1} — earlier:{' '}
                      {state.priorAttempts!.map((a) => `${a.status}${a.detail ? ` (${a.detail})` : ''}`).join(', ')}
                    </Text>
                  ) : null}
                  {nodePanelLiveLines.slice(outputWindow.start, outputWindow.end).map((line, i) => (
                    <Text key={`o${i}`} wrap="truncate-end">
                      {line || ' '}
                    </Text>
                  ))}
                  {nodePanelActivity.length > 0 ? (
                    <Text dimColor>
                      ── activity ──
                      {!activityWindow.following ? (
                        <Text dimColor>
                          {' '}
                          ({activityWindow.start} above
                          {nodePanelActivity.length - activityWindow.end > 0
                            ? `, ${nodePanelActivity.length - activityWindow.end} below`
                            : ''}
                          )
                        </Text>
                      ) : null}
                    </Text>
                  ) : null}
                  {nodePanelActivity.slice(activityWindow.start, activityWindow.end).map((entry, i) => (
                    <Text
                      key={`a${i}`}
                      wrap="truncate-end"
                      {...(entry.decision === 'denied' ? { color: 'red' } : {})}
                    >
                      {formatActivityRow(entry, nodePanelAgentLabels)}
                    </Text>
                  ))}
                </Box>
                <PanelFooter hint="PgUp/PgDn: activity · ⇧PgUp/PgDn: output · enter/esc: close · tab: focus" />
              </>
            );
          })()}
        </Box>
      ) : (
        // FOOTER_ROWS budgets one row for this too — see the header's note.
        // Only the keys you need before you have found `?`: everything else —
        // o/c/w, e/m/s, the mouse — is in the map that `?` opens, and listing
        // it here bought nothing but a row that truncated mid-word on any
        // terminal narrower than the whole list. The state those keys toggle
        // is reported in the header, which outlives this row anyway.
        //
        // `?` leads, then `q`: the row truncates from the right, and between
        // them they are the two you cannot discover any other way — one shows
        // the rest of the map, the other gets you out.
        <Text dimColor wrap="truncate-end">
          ?: keys · q: quit · tab: focus · enter: details · ←→↑↓: pan · z: zoom
        </Text>
      )}
    </Box>
  );
}
