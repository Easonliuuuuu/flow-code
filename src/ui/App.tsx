import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { join } from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { providerInfo, type ProviderId } from '../engine/providers.js';
import { windowFor } from '../init/SelectList.js';
import type { RunStateStore } from '../runstate/store.js';
import type { ActivityEntry, RunState } from '../runstate/types.js';
import { defaultSkillRoots, discoverSkills, type DiscoveredSkill } from '../skills/discover.js';
import { WORKFLOW_RELATIVE_PATH, type Workflow } from '../workflow/load.js';
import { resolveNodeModel } from '../workflow/modelResolution.js';
import { setNodeModel, setNodeSkills, WorkflowWriteError } from '../workflow/write.js';
import { gridToLines, nodeModelBadge, nodeSkillBadge, renderGraph, STATUS_GLYPHS } from './canvas.js';
import { formatDuration, formatTokens, totalTokens } from './nodeCard.js';
import {
  clampOffset,
  computeLayout,
  hitTest,
  offscreenCounts,
  scrollIntoView,
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

export function App({
  workflow,
  store,
  ports,
  onExit,
  onInterrupt,
  modelContext,
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
  const [inputBuffer, setInputBuffer] = useState('');
  const [convCursor, setConvCursor] = useState(0);
  const [convSelected, setConvSelected] = useState<Set<string>>(new Set());
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
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerCursor, setSkillPickerCursor] = useState(0);
  const [skillPickerSelected, setSkillPickerSelected] = useState<Set<string>>(new Set());

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
  const discussState = ports.discussState;
  const discussActive = discussState?.active ?? false;

  const panelOpen =
    expanded ||
    pendingApproval !== null ||
    pendingConvergence !== null ||
    discussActive ||
    pickerOpen ||
    skillPickerOpen;
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

  const layout = useMemo(() => computeLayout(workflow, overrides), [workflow, overrides]);
  const viewport = { ...offset, width: canvasWidth, height: canvasHeight };
  // Panning is clamped so it can never leave the graph off-screen entirely,
  // and goes through one helper so the keyboard and the scroll wheel agree.
  const panBy = (dx: number, dy: number): void => {
    setOffset((o) => clampOffset(layout, { ox: o.ox + dx, oy: o.oy + dy, width: canvasWidth, height: canvasHeight }));
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
  const focusedId = workflow.order[Math.min(focusIdx, workflow.order.length - 1)] ?? null;
  const focusedNode = workflow.nodes.find((n) => n.id === focusedId);

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
    setPickerOpen(true);
    modelListLoaderFor(modelContext.providerId).ensureLoaded();
  };

  const openSkillPicker = (nodeId: string): void => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (!node.type.agentDriven) {
      showPickerMessage(`${node.type.displayName} nodes have no skills to attach.`);
      return;
    }
    const catalogIds = new Set(skillCatalog.map((s) => s.id));
    const entries = (node.config as { skills?: string[] }).skills ?? [];
    setSkillPickerCursor(0);
    setSkillPickerSelected(new Set(entries.filter((e) => catalogIds.has(e))));
    setSkillPickerOpen(true);
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

  // Focus scrolls into view (keyboard navigation on graphs larger than the terminal).
  useEffect(() => {
    if (!focusedId) return;
    const box = layout.boxes.get(focusedId);
    if (!box) return;
    setOffset((prev) =>
      scrollIntoView(box, { ...prev, width: canvasWidth, height: canvasHeight }),
    );
  }, [focusedId, layout, canvasWidth, canvasHeight]);

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

  // Everything the mouse handler reads, mirrored into a ref. The handler is
  // registered once (see below) so it can't take these as effect deps: doing
  // so re-ran the effect on every render, writing mouse mode-set escapes into
  // the middle of Ink's frames on every streamed token.
  const mouseStateRef = useRef({
    layout,
    offset,
    activeRect,
    panelOpen,
    discussActive,
    discussWindow,
    pendingApproval,
    columns,
    rows,
    canvasWidth,
    canvasHeight,
    openModelPicker,
    openSkillPicker,
  });
  useEffect(() => {
    mouseStateRef.current = {
      layout,
      offset,
      activeRect,
      panelOpen,
      discussActive,
      discussWindow,
      pendingApproval,
      columns,
      rows,
      canvasWidth,
      canvasHeight,
      openModelPicker,
      openSkillPicker,
    };
  });

  // A fresh discussion (or re-entering one) starts following the live tail.
  useEffect(() => {
    setDiscussPin(null);
  }, [discussState?.nodeId, discussActive]);

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
          discussActive,
          pendingApproval,
          columns,
          rows,
          canvasWidth,
          canvasHeight,
          openModelPicker,
          openSkillPicker,
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
          const id = hitTest(layout, canvasX, canvasY);
          if (id) {
            setFocusIdx(Math.max(0, workflow.order.indexOf(id)));
            const box = layout.boxes.get(id);
            // The model badge is the only thing ever drawn on a box's type-label
            // row (see canvas.ts); clicking that row when a badge is present
            // opens the picker instead of starting a position drag, and every
            // other row is unaffected.
            if (box && canvasY === box.y + 2 && nodeModelBadge(workflow, id) !== null) {
              openModelPicker(id);
            } else if (box && canvasY === box.y + 2 && nodeSkillBadge(workflow, id) !== null) {
              openSkillPicker(id);
            } else {
              dragRef.current = { id, lastX: canvasX, lastY: canvasY };
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
          const canvasX = event.x + offset.ox;
          const canvasY = event.y - HEADER_ROWS + offset.oy;
          const drag = dragRef.current;
          const dx = canvasX - drag.lastX;
          const dy = canvasY - drag.lastY;
          if (dx !== 0 || dy !== 0) {
            drag.lastX = canvasX;
            drag.lastY = canvasY;
            setOverrides((prev) => {
              const next = new Map(prev);
              const cur = next.get(drag.id) ?? { dx: 0, dy: 0 };
              // Session-only: never written back to the workflow file.
              next.set(drag.id, { dx: cur.dx + dx, dy: cur.dy + dy });
              return next;
            });
          }
        } else if (event.kind === 'release') {
          dragRef.current = null;
          panelDragRef.current = null;
          setPanelDragMode(null);
        } else if (event.kind === 'scroll') {
          if (overPanel && discussActive) {
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

    // Discussion input mode captures the keyboard.
    if (discussActive && discussState) {
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
        setPickerOpen(false);
        return;
      }
      if (pickerFreeText !== null) {
        if (key.return) {
          const text = pickerFreeText.trim();
          setPickerOpen(false);
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
        setPickerOpen(false);
        confirmModel(focusedNode.id, models[pickerCursor]!);
      }
      return;
    }

    // Skill picker: same reachable-only-via-`s` guarantee as the model picker
    // above. Multi-select, so enter confirms the whole set rather than one item.
    if (skillPickerOpen && focusedNode) {
      if (key.escape) {
        setSkillPickerOpen(false);
        return;
      }
      if (key.return) {
        setSkillPickerOpen(false);
        confirmSkills(focusedNode.id, skillPickerSelected);
        return;
      }
      if (skillCatalog.length === 0) return;
      if (key.upArrow || input === 'k') {
        setSkillPickerCursor((c) => (c + skillCatalog.length - 1) % skillCatalog.length);
      } else if (key.downArrow || input === 'j') {
        setSkillPickerCursor((c) => (c + 1) % skillCatalog.length);
      } else if (input === ' ') {
        const id = skillCatalog[skillPickerCursor]!.id;
        setSkillPickerSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
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
      if (focusedNode) openModelPicker(focusedNode.id);
    } else if (input === 's') {
      if (focusedNode) openSkillPicker(focusedNode.id);
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
        <Text dimColor> run {runState.runId.slice(0, 8)} · </Text>
        <Text>{headerParts.join('  ')}</Text>
        {runTokens > 0 ? (
          <Text color="cyan"> · {formatTokens(runTokens)} tok</Text>
        ) : null}
        {finished ? <Text color="green"> · finished — press q to exit</Text> : null}
        {/* Lives in the header rather than the bottom hint line because the
            hint line disappears behind a docked panel — which is exactly when
            the canvas is smallest and the most nodes are off-screen. */}
        {offscreenHint ? <Text dimColor> · {offscreenHint} off-screen (⇧+arrows)</Text> : null}
        {floating ? <Text dimColor> · ctrl+p: dock panel</Text> : null}
        {pickerMessage ? <Text color="yellow"> · {pickerMessage}</Text> : null}
      </Text>
      <Box flexDirection="column" height={canvasHeight}>
        {canvasLines.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
      {discussActive && discussState ? (
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
          {/* Grows to fill the panel so the transcript stays anchored to the
              input line and the footer keeps its grip in the corner. */}
          <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
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
          <PanelFooter hint="enter: send · /done: finish · PgUp/PgDn: scroll · drag ⠿/edge: move · ⇲: resize" />
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
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {(() => {
              const lines = pendingApproval.req.diffs.flatMap((d) => [
                ...(d.label ? [`── ${d.label} ──`] : []),
                ...(d.diff.length > 0 ? d.diff.split('\n') : ['(no changes)']),
              ]);
              const visible = Math.max(1, panelHeight - 6);
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
                    (() => {
                      const { start, end } = windowFor(skillPickerCursor, skillCatalog.length, 10);
                      return (
                        <>
                          {start > 0 ? <Text dimColor> ↑ {start} more above</Text> : null}
                          {skillCatalog.slice(start, end).map((skill, i) => {
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
                          {end < skillCatalog.length ? (
                            <Text dimColor> ↓ {skillCatalog.length - end} more below</Text>
                          ) : null}
                        </>
                      );
                    })()
                  )}
                </>
              );
            })()}
          </Box>
          <PanelFooter hint="↑/↓: move · space: toggle · enter: confirm · esc: cancel" />
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
                  {focusedNode.type.agentDriven ? (
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
          tab: focus · enter: details · ←→↑↓ (⇧ anywhere): pan · q: quit
          {focusedNode ? ` · focused: ${focusedNode.id}` : ''}
        </Text>
      )}
    </Box>
  );
}
