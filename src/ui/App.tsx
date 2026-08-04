import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { join } from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { providerInfo, type ProviderId } from '../engine/providers.js';
import { windowFor } from '../init/SelectList.js';
import { nodeTypeAcceptsAgentStep } from '../registry/index.js';
import type { RunStateStore } from '../runstate/store.js';
import type { ActivityEntry, RunState } from '../runstate/types.js';
import { isAttached, isDriverAlive } from '../runstate/watch.js';
import { defaultSkillRoots, discoverSkills, type DiscoveredSkill } from '../skills/discover.js';
import { WORKFLOW_RELATIVE_PATH, type Workflow } from '../workflow/load.js';
import { resolveNodeModel } from '../workflow/modelResolution.js';
import {
  setNodeBudgetTokens,
  setNodeConfigString,
  setNodeModel,
  setNodeSkills,
  WorkflowWriteError,
} from '../workflow/write.js';
import { gridToLines, nodeModelBadge, nodeSkillBadge, renderGraph, STATUS_GLYPHS } from './canvas.js';
import { formatDuration, formatTokens, totalTokens } from './nodeCard.js';
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
  MOVE_HANDLE,
  RESIZE_GRIP,
  tailWindow,
  type PanelRect,
} from './panel.js';
import { editableFields, parseFieldValue, type EditorField } from './nodeEditor.js';
import type { UiInteractionPorts } from './ports.js';
import { renderMarkdown, renderPlain, segmentStyle } from './markdown.js';
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
}

function formatActivityRow(entry: ActivityEntry): string {
  const time = entry.ts.slice(11, 19);
  const summary = entry.summary.length > 42 ? `${entry.summary.slice(0, 42)}…` : entry.summary;
  const decision =
    entry.decision === 'denied' ? `DENIED (${entry.missingCapability ?? '?'})` : 'allowed';
  const exit =
    entry.exitStatus !== undefined && entry.exitStatus !== null ? ` exit ${entry.exitStatus}` : '';
  const duration = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
  return `${time}  ${entry.tool.padEnd(8)} ${summary.padEnd(44)} ${decision}${exit}${duration}`;
}

function tail<T>(items: T[], n: number): T[] {
  return items.slice(Math.max(0, items.length - n));
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
  useEffect(() => ports.subscribe(() => setPortsTick((t) => t + 1)), [ports]);

  // Animation clock for running node cards (spinner, ticking elapsed time).
  // It only runs while something is actually running, so an idle or finished
  // graph costs nothing and redraws nothing.
  const anyRunning = Object.values(runState.nodes).some((n) => n.status === 'running');
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
  // Discuss is the one blocking prompt you can step away from: tabbing (or
  // clicking) to another node hides the conversation — still paused,
  // draft still in `inputBuffer` — in favor of that node's own panel, and
  // tabbing back re-shows it. Every other pending-* prompt below stays
  // forced open regardless of focus, since those are short single
  // decisions where losing track of the request matters more than being
  // able to browse mid-decision.
  const discussPanelOpen = discussActive && discussState?.nodeId === focusedId;

  const panelOpen =
    expanded ||
    pendingApproval !== null ||
    pendingConvergence !== null ||
    pendingTestCommands !== null ||
    discussPanelOpen ||
    pickerOpen ||
    skillPickerOpen ||
    editorOpen;
  const floating = panelRect !== null;
  const docked = dockedLayout({ columns, rows }, HEADER_ROWS);
  // A docked, open panel reserves flow space below the canvas; a floating one
  // overlays it instead, so the canvas reclaims that space (same as closed).
  // When docked the canvas height must come from dockedLayout, or the panel
  // stops lining up with the rect the mouse is hit-tested against.
  const canvasHeight =
    panelOpen && !floating
      ? docked.canvasHeight
      : Math.max(1, rows - HEADER_ROWS - FOOTER_ROWS);
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
  const measuredLayout = useMemo(() => computeLayout(workflow), [workflow]);
  const fullLayout = useMemo(() => computeLayout(workflow, overrides), [workflow, overrides]);
  const compactLayout = useMemo(
    () => computeLayout(workflow, overrides, { density: 'compact' }),
    [workflow, overrides],
  );
  const miniLayout = useMemo(
    () => computeLayout(workflow, overrides, { density: 'mini' }),
    [workflow, overrides],
  );
  const autoZoom = measuredLayout.height > canvasHeight ? 1 : 0;
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

  const openModelPicker = (nodeId: string): void => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (!node.type.hasModelField) {
      showPickerMessage(`${node.type.displayName} nodes have no model to choose.`);
      return;
    }
    if (!modelContext.providerId) {
      showPickerMessage('no provider configured — run `flow-code init` to choose one.');
      return;
    }
    setPickerCursor(0);
    setPickerFreeText(null);
    setPanelNodeId(nodeId);
    setPickerOpen(true);
    modelListLoaderFor(modelContext.providerId).ensureLoaded();
  };

  const openSkillPicker = (nodeId: string): void => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (!nodeTypeAcceptsAgentStep(node.type)) {
      showPickerMessage(`${node.type.displayName} nodes have no skills to attach.`);
      return;
    }
    const catalogIds = new Set(skillCatalog.map((s) => s.id));
    const entries = (node.config as { skills?: string[] }).skills ?? [];
    setSkillPickerCursor(0);
    setSkillPickerQuery('');
    setSkillPickerSelected(new Set(entries.filter((e) => catalogIds.has(e))));
    setPanelNodeId(nodeId);
    setSkillPickerOpen(true);
  };

  const editorFields = focusedNode ? editableFields(focusedNode) : [];
  const editorField = editorFields[Math.min(editorCursor, editorFields.length - 1)];

  const openEditor = (nodeId: string): void => {
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
    try {
      if (parsed.kind === 'number') setNodeBudgetTokens(path, nodeId, parsed.value);
      else setNodeConfigString(path, nodeId, field.key, parsed.value);
    } catch (err) {
      showPickerMessage(
        err instanceof WorkflowWriteError ? err.message : `could not save ${field.label}: ${String(err)}`,
      );
      return;
    }
    if (parsed.kind === 'number') {
      if (parsed.value === null) delete node.budget;
      else node.budget = { ...node.budget, tokens: parsed.value };
    } else {
      const config = { ...(node.config as Record<string, unknown>) };
      if (parsed.value === null) delete config[field.key];
      else config[field.key] = parsed.value;
      node.config = config;
    }
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
    try {
      setNodeModel(join(runState.repoRoot, WORKFLOW_RELATIVE_PATH), nodeId, toWrite);
    } catch (err) {
      showPickerMessage(
        err instanceof WorkflowWriteError ? err.message : `could not save model: ${String(err)}`,
      );
      return;
    }
    const config = { ...(node.config as Record<string, unknown>) };
    if (toWrite === null) delete config['model'];
    else config['model'] = toWrite;
    node.config = config;
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
    try {
      setNodeSkills(join(runState.repoRoot, WORKFLOW_RELATIVE_PATH), nodeId, toWrite);
    } catch (err) {
      showPickerMessage(
        err instanceof WorkflowWriteError ? err.message : `could not save skills: ${String(err)}`,
      );
      return;
    }
    const config = { ...(node.config as Record<string, unknown>) };
    if (toWrite.length === 0) delete config['skills'];
    else config['skills'] = toWrite;
    node.config = config;
    node.skills = toWrite
      .map((id) => skillCatalog.find((s) => s.id === id))
      .filter((s): s is DiscoveredSkill => s !== undefined);
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

  // Wrapped transcript rows for the Discuss panel, and the scrollback window
  // into them (see tailWindow's doc comment for the follow/pin model).
  const discussTranscriptWidth = Math.max(10, activeRect.w - 6);
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
  const discussWindow = tailWindow(discussRows.length, Math.max(1, panelHeight - 5), discussPin);

  /**
   * Whether a prompt is blocking on this node. A blocking prompt owns the
   * keyboard outright, so `m`/`s` can't reach the pickers while one is up
   * (see the mode chain in useInput) — and the mouse has to honour the same
   * rule. A badge click that opened a picker underneath one of these left it
   * invisible behind the higher-priority panel and keyboard-unreachable, then
   * sprang it on you the moment the prompt was answered. Discuss is judged
   * per node, since a paused discussion elsewhere in the graph is exactly the
   * case tabbing away is meant to allow.
   */
  const blockingPromptFor = (nodeId: string): boolean =>
    pendingApproval !== null ||
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
    discussPanelOpen,
    discussWindow,
    pendingApproval,
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
      discussPanelOpen,
      discussWindow,
      pendingApproval,
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
          discussPanelOpen,
          pendingApproval,
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
          const canvasY = event.y - HEADER_ROWS + offset.oy;
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
          // Ctrl+wheel zooms the canvas — but only over the canvas. Over an
          // open panel the wheel belongs to whatever is being read there, and
          // a stray ctrl while scrolling a conversation should not resize the
          // graph behind it. Wheel-up is zoom *in*, matching every other
          // zoomable surface.
          if (event.ctrl && !overPanel) {
            zoomBy(event.direction === 'down' ? 1 : -1);
          } else if (overPanel && discussPanelOpen) {
            setDiscussPin(
              pinAfterScroll(mouseStateRef.current.discussWindow, event.direction === 'down' ? -3 : 3),
            );
          } else if (pendingApproval) {
            setDiffScroll((s) => Math.max(0, s + (event.direction === 'down' ? 1 : -1)));
          } else {
            setOffset((o) =>
              clampOffset(layout, {
                ox: o.ox,
                oy: o.oy + (event.direction === 'down' ? PAN_STEP_Y : -PAN_STEP_Y),
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
      if (key.pageUp) {
        setDiscussPin(pinAfterScroll(discussWindow, Math.max(1, panelHeight - 6)));
        return;
      }
      if (key.pageDown) {
        setDiscussPin(pinAfterScroll(discussWindow, -Math.max(1, panelHeight - 6)));
        return;
      }
      if (key.return) {
        const text = inputBuffer.trim();
        setInputBuffer('');
        setDiscussPin(null);
        if (text === '/done' || text === '/exit') ports.submitUserMessage(null);
        else if (text.length > 0) ports.submitUserMessage(text);
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
        if (key.escape) {
          setTestCommandInput(null);
        } else if (key.return) {
          const command = testCommandInput.trim();
          if (command.length > 0) {
            setTestCommandExtra((prev) => [...prev, command]);
            setTestCommandSelected((prev) => new Set([...prev, command]));
          }
          setTestCommandInput(null);
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

    // Approval gate: keyboard-first approve/reject.
    if (pendingApproval) {
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
      if (key.tab) setFocusIdx((i) => (i + 1) % workflow.order.length);
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
        }
        return;
      }
      if (key.return) {
        commitEditorField(focusedNode.id, editorField, editorBuffer);
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
      if (key.backspace || key.delete) {
        setSkillPickerQuery((q) => q.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
        setSkillPickerQuery((q) => q + input);
      }
      return;
    }

    // Normal navigation.
    if (key.tab && key.shift) {
      setFocusIdx((i) => (i + workflow.order.length - 1) % workflow.order.length);
    } else if (key.tab) {
      setFocusIdx((i) => (i + 1) % workflow.order.length);
    } else if (key.return) {
      setExpanded((e) => !e);
    } else if (input === 'm') {
      if (watch) showPickerMessage(WATCH_READ_ONLY_MESSAGE);
      else if (focusedNode) openModelPicker(focusedNode.id);
    } else if (input === 's') {
      if (watch) showPickerMessage(WATCH_READ_ONLY_MESSAGE);
      else if (focusedNode) openSkillPicker(focusedNode.id);
    } else if (input === 'e') {
      if (watch) showPickerMessage(WATCH_READ_ONLY_MESSAGE);
      else if (focusedNode) openEditor(focusedNode.id);
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

  const statusCounts = Object.values(runState.nodes).reduce<Record<string, number>>(
    (acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }),
    {},
  );
  const finished = runState.finishedAt !== undefined;
  const runTokens = totalTokens(runState.nodes);
  const headerParts = Object.entries(statusCounts).map(
    ([status, count]) => `${STATUS_GLYPHS[status as keyof typeof STATUS_GLYPHS]} ${count}`,
  );

  // Watch-mode header. Both facts are pure functions of the state just
  // applied, so they re-derive on every snapshot with no extra plumbing
  // between the watcher and this component.
  const watchAttached = watch && isAttached(runState);
  // A run that ended is not "stale" — it has no driver because it's over.
  const driverGone = watchAttached && !finished && !isDriverAlive(runState);
  const runLabel = watch
    ? watchAttached
      ? `watching ${runState.runId.slice(0, 8)}`
      : 'waiting for a run'
    : `run ${runState.runId.slice(0, 8)}`;

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

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Text>
        <Text bold color="cyan">
          flow-code
        </Text>
        <Text dimColor> {runLabel} · </Text>
        <Text>{headerParts.join('  ')}</Text>
        {runTokens > 0 ? (
          <Text color="cyan"> · {formatTokens(runTokens)} tok</Text>
        ) : null}
        {driverGone ? <Text color="yellow"> · driver gone</Text> : null}
        {finished ? <Text color="green"> · finished — press q to exit</Text> : null}
        {/* Lives in the header rather than the bottom hint line because the
            hint line disappears behind a docked panel — which is exactly when
            the canvas is smallest and the most nodes are off-screen. */}
        {density === 'mini' ? <Text dimColor> · overview</Text> : null}
        {camera === 'nudge' ? <Text dimColor> · free camera</Text> : null}
        {offscreenHint ? <Text dimColor> · {offscreenHint} off-screen (⇧+arrows)</Text> : null}
        {floating ? <Text dimColor> · ctrl+p: dock panel</Text> : null}
        {pickerMessage ? <Text color="yellow"> · {pickerMessage}</Text> : null}
      </Text>
      <Box flexDirection="column" height={canvasHeight}>
        {canvasLines.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
      {discussPanelOpen && discussState ? (
        <Box {...panelBoxProps}>
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
          <Text wrap="truncate-end">
            {discussState.awaitingUser ? (
              <>
                <Text color="cyan">{'> '}</Text>
                {/* Show the tail of a long line so the caret stays on screen. */}
                {inputBuffer.slice(Math.max(0, inputBuffer.length - discussInputWidth))}
                <Text inverse> </Text>
              </>
            ) : (
              <Text dimColor>… agent is thinking</Text>
            )}
          </Text>
          <PanelFooter hint="enter: send · tab: other nodes · /done: finish · PgUp/PgDn: scroll · drag ⠿/edge: move · ⇲: resize" />
        </Box>
      ) : pendingTestCommands ? (
        <Box {...panelBoxProps}>
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
                : '↑/↓: move · space: select · a: add · d: let flow-code find them · enter: confirm · esc: skip'
            }
          />
        </Box>
      ) : pendingConvergence ? (
        <Box {...panelBoxProps}>
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
          <PanelFooter hint="↑/↓: move · space: select · enter: confirm · drag ⠿/edge: move · ⇲: resize" />
        </Box>
      ) : pendingApproval ? (
        <Box {...panelBoxProps}>
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
            const summaryLines = wrapText(pendingApproval.req.agentSummary, Math.max(10, activeRect.w - 4)).slice(
              0,
              4,
            );
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
              const lines = pendingApproval.req.diffs.flatMap((d) => [
                ...(d.label ? [`── ${d.label} ──`] : []),
                ...(d.diff.length > 0 ? d.diff.split('\n') : ['(no changes)']),
              ]);
              const summaryBudget = pendingApproval.req.agentSummary
                ? Math.min(4, wrapText(pendingApproval.req.agentSummary, Math.max(10, activeRect.w - 4)).length) + 1
                : 0;
              const visible = Math.max(1, panelHeight - 6 - summaryBudget);
              const start = Math.min(diffScroll, Math.max(0, lines.length - visible));
              return lines.slice(start, start + visible).map((line, i) => (
                <Text
                  key={i}
                  wrap="truncate-end"
                  {...(line.startsWith('+')
                    ? { color: 'green' }
                    : line.startsWith('-')
                      ? { color: 'red' }
                      : {})}
                  dimColor={line.startsWith('@@') || line.startsWith('──')}
                >
                  {line || ' '}
                </Text>
              ));
            })()}
          </Box>
          <PanelFooter hint="[a] approve · [r] reject · j/k: scroll diff · drag ⠿/edge: move · ⇲: resize" />
        </Box>
      ) : pickerOpen && focusedNode ? (
        <Box {...panelBoxProps}>
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
          <PanelFooter hint="type: filter · ↑/↓: move · space: toggle · enter: confirm · esc: clear/cancel" />
        </Box>
      ) : editorOpen && focusedNode ? (
        <Box {...panelBoxProps}>
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
          {(() => {
            const state = runState.nodes[focusedNode.id]!;
            const activity = runState.activity.filter((e) => e.nodeId === focusedNode.id);
            const live = store.liveOutputFor(focusedNode.id);
            // Agent output is prose, not a table: wrap it to the panel's inner
            // width (borders + paddingX) so long sentences stay readable
            // instead of running past the right edge and being cut off.
            const outputWidth = Math.max(10, activeRect.w - 4);
            const liveLines =
              live.length > 0
                ? live
                    .trimEnd()
                    .split('\n')
                    .flatMap((line) => wrapText(line.replace(/\t/g, '    '), outputWidth))
                : [];
            // Rows left for output + activity: the panel minus its borders,
            // title, config line, activity separator and footer.
            const bodyBudget = Math.max(2, panelHeight - 6);
            const outputBudget = Math.max(1, Math.floor(bodyBudget / 2));
            const activityBudget = Math.max(1, bodyBudget - outputBudget);
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
                  <Text dimColor wrap="truncate-end">
                    config: {JSON.stringify(focusedNode.config)}
                  </Text>
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
                  {state.tokens || state.startedAt ? (
                    <Text dimColor wrap="truncate-end">
                      {state.tokens
                        ? `tokens: ${formatTokens(state.tokens.input)} in` +
                          `${state.tokens.cached > 0 ? ` (+${formatTokens(state.tokens.cached)} cached)` : ''}` +
                          ` · ${formatTokens(state.tokens.output)} out`
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
                  {tail(liveLines, outputBudget).map((line, i) => (
                    <Text key={`o${i}`} wrap="truncate-end">
                      {line || ' '}
                    </Text>
                  ))}
                  {activity.length > 0 ? <Text dimColor>── activity ──</Text> : null}
                  {tail(activity, activityBudget).map((entry, i) => (
                    <Text
                      key={`a${i}`}
                      wrap="truncate-end"
                      {...(entry.decision === 'denied' ? { color: 'red' } : {})}
                    >
                      {formatActivityRow(entry)}
                    </Text>
                  ))}
                </Box>
                <PanelFooter hint="enter: close · tab: focus · drag ⠿/edge: move · ⇲: resize" />
              </>
            );
          })()}
        </Box>
      ) : (
        <Text dimColor>
          tab: focus · enter: details · {watch ? 'read-only' : 'e: settings'} · ←→↑↓ (⇧ anywhere):
          pan · ctrl+wheel/z: zoom ({density}) · o: {density === 'mini' ? 'back' : 'overview'} · c:
          camera · q: quit
          {focusedNode ? ` · focused: ${focusedNode.id}` : ''}
        </Text>
      )}
    </Box>
  );
}
