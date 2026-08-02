import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { join } from 'node:path';
import { useEffect, useMemo, useRef, useState } from 'react';
import { providerInfo } from '../engine/providers.js';
import { windowFor } from '../init/SelectList.js';
import { WORKFLOW_RELATIVE_PATH } from '../workflow/load.js';
import { resolveNodeModel } from '../workflow/modelResolution.js';
import { setNodeModel, WorkflowWriteError } from '../workflow/write.js';
import { gridToLines, nodeModelBadge, renderGraph, STATUS_GLYPHS } from './canvas.js';
import { formatDuration, formatTokens, totalTokens } from './nodeCard.js';
import { computeLayout, hitTest, scrollIntoView } from './layout.js';
import { disableMouse, enableMouse, LEAKED_MOUSE_SEQUENCE, parseMouseEvents } from './mouse.js';
import { createModelListLoader } from './modelListLoader.js';
import { applyPanelMove, applyPanelResize, dockedLayout, hitTestPanel, pinAfterScroll, MOVE_HANDLE, RESIZE_GRIP, tailWindow, } from './panel.js';
import { renderMarkdown, renderPlain, segmentStyle } from './markdown.js';
import { wrapText } from './textwrap.js';
/** The header line above the canvas, and the hint line below it when no panel is docked. */
const HEADER_ROWS = 1;
const FOOTER_ROWS = 1;
/** Spinner/elapsed-clock cadence: fast enough to read as motion, slow enough not to churn frames. */
const ANIMATION_INTERVAL_MS = 120;
function formatActivityRow(entry) {
    const time = entry.ts.slice(11, 19);
    const summary = entry.summary.length > 42 ? `${entry.summary.slice(0, 42)}…` : entry.summary;
    const decision = entry.decision === 'denied' ? `DENIED (${entry.missingCapability ?? '?'})` : 'allowed';
    const exit = entry.exitStatus !== undefined && entry.exitStatus !== null ? ` exit ${entry.exitStatus}` : '';
    const duration = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
    return `${time}  ${entry.tool.padEnd(8)} ${summary.padEnd(44)} ${decision}${exit}${duration}`;
}
function tail(items, n) {
    return items.slice(Math.max(0, items.length - n));
}
/**
 * Title row of a panel. The whole row is a move zone (see hitTestPanel), so it
 * leads with a drag handle to say so.
 */
function PanelTitle({ children }) {
    return (_jsxs(Box, { flexShrink: 0, children: [_jsxs(Text, { dimColor: true, children: [MOVE_HANDLE, " "] }), children] }));
}
/**
 * Bottom row of a panel: key hints on the left, and the resize grip sitting in
 * the very corner it grabs.
 */
function PanelFooter({ hint }) {
    return (_jsxs(Box, { flexShrink: 0, justifyContent: "space-between", children: [_jsx(Text, { dimColor: true, wrap: "truncate-end", children: hint }), _jsx(Text, { dimColor: true, children: RESIZE_GRIP })] }));
}
export function App({ workflow, store, ports, onExit, onInterrupt, modelContext, }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const { stdin } = useStdin();
    const [runState, setRunState] = useState(store.snapshot());
    const [frame, setFrame] = useState(0);
    const [, setPortsTick] = useState(0);
    const [focusIdx, setFocusIdx] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [offset, setOffset] = useState({ ox: 0, oy: 0 });
    const [overrides, setOverrides] = useState(new Map());
    const [inputBuffer, setInputBuffer] = useState('');
    const [convCursor, setConvCursor] = useState(0);
    const [convSelected, setConvSelected] = useState(new Set());
    const [diffScroll, setDiffScroll] = useState(0);
    // null = following the live tail; a number pins the transcript to that
    // absolute row so new messages don't disturb a mid-scroll read.
    const [discussPin, setDiscussPin] = useState(null);
    // null = docked (full width, pinned to the bottom, auto height). Set once the
    // panel is dragged or resized, and persists — including across different
    // panel content (Discuss/Approval/etc.) — until reset with ctrl+p.
    const [panelRect, setPanelRect] = useState(null);
    // Mirrors panelDragRef into render state purely so the border can light up
    // while dragging — feedback that the grab actually landed on the handle.
    const [panelDragMode, setPanelDragMode] = useState(null);
    const dragRef = useRef(null);
    const panelDragRef = useRef(null);
    // Model picker: opened with `m` on the focused node (or a click on its
    // model badge). Renders in the same status panel as Discuss/Approval/etc.
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerCursor, setPickerCursor] = useState(0);
    // null = list mode; a string (possibly empty) = free-text entry, used when
    // the provider's model list failed to load.
    const [pickerFreeText, setPickerFreeText] = useState(null);
    // Transient feedback for actions that don't open a panel: a decline (no
    // model field, no provider) or a failed save. Shown in the header, which —
    // unlike the bottom hint line — is visible no matter what panel is open.
    const [pickerMessage, setPickerMessage] = useState(null);
    const pickerMessageTimeoutRef = useRef(null);
    // Bumped after mutating a node's config in place (see confirmModel) so the
    // badge and detail view re-render from the change — that mutation isn't
    // itself React state.
    const [modelTick, setModelTick] = useState(0);
    const modelListLoadersRef = useRef(new Map());
    const [modelListTick, setModelListTick] = useState(0);
    useEffect(() => () => {
        if (pickerMessageTimeoutRef.current)
            clearTimeout(pickerMessageTimeoutRef.current);
    }, []);
    useEffect(() => store.subscribe(setRunState), [store]);
    useEffect(() => ports.subscribe(() => setPortsTick((t) => t + 1)), [ports]);
    // Animation clock for running node cards (spinner, ticking elapsed time).
    // It only runs while something is actually running, so an idle or finished
    // graph costs nothing and redraws nothing.
    const anyRunning = Object.values(runState.nodes).some((n) => n.status === 'running');
    useEffect(() => {
        if (!anyRunning)
            return;
        const timer = setInterval(() => setFrame((f) => f + 1), ANIMATION_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [anyRunning]);
    const columns = stdout.columns ?? 100;
    const rows = stdout.rows ?? 30;
    const pendingApproval = ports.pendingApproval;
    const pendingConvergence = ports.pendingConvergence;
    const discussState = ports.discussState;
    const discussActive = discussState?.active ?? false;
    const panelOpen = expanded || pendingApproval !== null || pendingConvergence !== null || discussActive || pickerOpen;
    const floating = panelRect !== null;
    const docked = dockedLayout({ columns, rows }, HEADER_ROWS);
    // A docked, open panel reserves flow space below the canvas; a floating one
    // overlays it instead, so the canvas reclaims that space (same as closed).
    // When docked the canvas height must come from dockedLayout, or the panel
    // stops lining up with the rect the mouse is hit-tested against.
    const canvasHeight = panelOpen && !floating
        ? docked.canvasHeight
        : Math.max(1, rows - HEADER_ROWS - FOOTER_ROWS);
    const activeRect = floating ? panelRect : docked.rect;
    const panelHeight = activeRect.h;
    const layout = useMemo(() => computeLayout(workflow, overrides), [workflow, overrides]);
    const focusedId = workflow.order[Math.min(focusIdx, workflow.order.length - 1)] ?? null;
    const focusedNode = workflow.nodes.find((n) => n.id === focusedId);
    const showPickerMessage = (text) => {
        setPickerMessage(text);
        if (pickerMessageTimeoutRef.current)
            clearTimeout(pickerMessageTimeoutRef.current);
        pickerMessageTimeoutRef.current = setTimeout(() => setPickerMessage(null), 3000);
    };
    const modelListLoaderFor = (provider) => {
        let loader = modelListLoadersRef.current.get(provider);
        if (!loader) {
            const apiKeyEnvVar = providerInfo(provider).apiKeyEnvVar;
            loader = createModelListLoader(provider, apiKeyEnvVar ? process.env[apiKeyEnvVar] : undefined, () => setModelListTick((t) => t + 1));
            modelListLoadersRef.current.set(provider, loader);
        }
        return loader;
    };
    const openModelPicker = (nodeId) => {
        const node = workflow.nodes.find((n) => n.id === nodeId);
        if (!node)
            return;
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
    /**
     * Writes `model` to the node's config on disk and, so the current run
     * picks it up without a restart, on the same in-memory `WorkflowNode`
     * object the engine reads at node-start time (mirroring the fallback
     * `cmdRun` already applies to `workflow.settings.model`). Selecting the
     * model the node would already resolve to by default clears the override
     * instead of writing a redundant one.
     */
    const confirmModel = (nodeId, model) => {
        const node = workflow.nodes.find((n) => n.id === nodeId);
        if (!node)
            return;
        const toWrite = model === workflow.settings.model ? null : model;
        try {
            setNodeModel(join(runState.repoRoot, WORKFLOW_RELATIVE_PATH), nodeId, toWrite);
        }
        catch (err) {
            showPickerMessage(err instanceof WorkflowWriteError ? err.message : `could not save model: ${String(err)}`);
            return;
        }
        const config = { ...node.config };
        if (toWrite === null)
            delete config['model'];
        else
            config['model'] = toWrite;
        node.config = config;
        setModelTick((t) => t + 1);
    };
    // Focus scrolls into view (keyboard navigation on graphs larger than the terminal).
    useEffect(() => {
        if (!focusedId)
            return;
        const box = layout.boxes.get(focusedId);
        if (!box)
            return;
        setOffset((prev) => scrollIntoView(box, { ...prev, width: columns - 2, height: canvasHeight }));
    }, [focusedId, layout, columns, canvasHeight]);
    // Auto-focus a gate when its approval request arrives.
    useEffect(() => {
        if (pendingApproval) {
            const idx = workflow.order.indexOf(pendingApproval.req.nodeId);
            if (idx >= 0)
                setFocusIdx(idx);
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
        if (!discussState)
            return [];
        return discussState.transcript.flatMap((entry, entryIdx) => {
            const prefix = entry.role === 'user' ? 'you: ' : 'agent: ';
            const body = Math.max(4, discussTranscriptWidth - prefix.length);
            // The user typed plain text; the agent answers in markdown, so only the
            // agent's side is parsed — nobody wants their own `*` reinterpreted.
            const lines = entry.role === 'user' ? renderPlain(entry.text, body) : renderMarkdown(entry.text, body);
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
        openModelPicker,
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
            openModelPicker,
        };
    });
    // A fresh discussion (or re-entering one) starts following the live tail.
    useEffect(() => {
        setDiscussPin(null);
    }, [discussState?.nodeId, discussActive]);
    // Mouse: enhancement layer only. Terminals without mouse reporting simply
    // never emit these sequences; everything stays keyboard-operable.
    useEffect(() => {
        if (!stdin || !stdout.isTTY)
            return;
        enableMouse(stdout);
        const onData = (data) => {
            const events = parseMouseEvents(data.toString());
            for (const event of events) {
                const { layout, offset, activeRect, panelOpen, discussActive, pendingApproval, columns, rows, openModelPicker, } = mouseStateRef.current;
                const overPanel = panelOpen &&
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
                    if (overPanel)
                        continue; // clicks inside panel content (not its border) aren't a canvas drag
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
                        }
                        else {
                            dragRef.current = { id, lastX: canvasX, lastY: canvasY };
                        }
                    }
                }
                else if (event.kind === 'drag' && panelDragRef.current) {
                    const drag = panelDragRef.current;
                    const dx = event.x - drag.startX;
                    const dy = event.y - drag.startY;
                    setPanelRect(drag.mode === 'resize'
                        ? applyPanelResize(drag.origin, dx, dy, { columns, rows })
                        : applyPanelMove(drag.origin, dx, dy, { columns, rows }));
                }
                else if (event.kind === 'drag' && dragRef.current) {
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
                }
                else if (event.kind === 'release') {
                    dragRef.current = null;
                    panelDragRef.current = null;
                    setPanelDragMode(null);
                }
                else if (event.kind === 'scroll') {
                    if (overPanel && discussActive) {
                        setDiscussPin(pinAfterScroll(mouseStateRef.current.discussWindow, event.direction === 'down' ? -3 : 3));
                    }
                    else if (pendingApproval) {
                        setDiffScroll((s) => Math.max(0, s + (event.direction === 'down' ? 1 : -1)));
                    }
                    else {
                        setOffset((o) => ({
                            ...o,
                            oy: event.direction === 'down' ? o.oy + 2 : Math.max(0, o.oy - 2),
                        }));
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
                if (text === '/done' || text === '/exit')
                    ports.submitUserMessage(null);
                else if (text.length > 0)
                    ports.submitUserMessage(text);
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
            if (key.upArrow || input === 'k')
                setConvCursor((c) => (c + count - 1) % count);
            else if (key.downArrow || input === 'j')
                setConvCursor((c) => (c + 1) % count);
            else if (input === ' ') {
                const id = req.branches[convCursor].instanceId;
                setConvSelected((prev) => {
                    const next = req.mode === 'compare' ? new Set() : new Set(prev);
                    if (prev.has(id))
                        next.delete(id);
                    else
                        next.add(id);
                    return next;
                });
            }
            else if (key.return) {
                const selected = [...convSelected];
                const valid = req.mode === 'compare' ? selected.length === 1 : selected.length >= 1;
                if (valid)
                    resolve(selected);
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
            if (input === 'j' || key.downArrow)
                setDiffScroll((s) => s + 1);
            if (input === 'k' || key.upArrow)
                setDiffScroll((s) => Math.max(0, s - 1));
            if (key.tab)
                setFocusIdx((i) => (i + 1) % workflow.order.length);
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
                    if (text.length > 0)
                        confirmModel(focusedNode.id, text);
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
            if (pickerModelListState?.status !== 'loaded')
                return; // loading, or failed and about to flip to free-text
            const models = pickerModelListState.models;
            if (models.length === 0)
                return;
            if (key.upArrow || input === 'k')
                setPickerCursor((c) => (c + models.length - 1) % models.length);
            else if (key.downArrow || input === 'j')
                setPickerCursor((c) => (c + 1) % models.length);
            else if (key.return) {
                setPickerOpen(false);
                confirmModel(focusedNode.id, models[pickerCursor]);
            }
            return;
        }
        // Normal navigation.
        if (key.tab && key.shift) {
            setFocusIdx((i) => (i + workflow.order.length - 1) % workflow.order.length);
        }
        else if (key.tab) {
            setFocusIdx((i) => (i + 1) % workflow.order.length);
        }
        else if (key.return) {
            setExpanded((e) => !e);
        }
        else if (input === 'm') {
            if (focusedNode)
                openModelPicker(focusedNode.id);
        }
        else if (key.leftArrow) {
            setOffset((o) => ({ ...o, ox: Math.max(0, o.ox - 4) }));
        }
        else if (key.rightArrow) {
            setOffset((o) => ({ ...o, ox: o.ox + 4 }));
        }
        else if (key.upArrow) {
            setOffset((o) => ({ ...o, oy: Math.max(0, o.oy - 2) }));
        }
        else if (key.downArrow) {
            setOffset((o) => ({ ...o, oy: o.oy + 2 }));
        }
        else if (input === 'q') {
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
    () => renderGraph(workflow, layout, runState, focusedId, { frame, now: Date.now() }), [workflow, layout, runState, focusedId, modelTick, frame]);
    const canvasLines = useMemo(() => gridToLines(grid, { ...offset, width: columns - 2, height: canvasHeight }), [grid, offset, columns, canvasHeight]);
    const statusCounts = Object.values(runState.nodes).reduce((acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }), {});
    const finished = runState.finishedAt !== undefined;
    const runTokens = totalTokens(runState.nodes);
    const headerParts = Object.entries(statusCounts).map(([status, count]) => `${STATUS_GLYPHS[status]} ${count}`);
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
            ? {
                position: 'absolute',
                left: activeRect.x,
                top: activeRect.y,
                width: activeRect.w,
                height: activeRect.h,
            }
            : { height: panelHeight }),
    };
    return (_jsxs(Box, { flexDirection: "column", width: columns, height: rows, children: [_jsxs(Text, { children: [_jsx(Text, { bold: true, color: "cyan", children: "flow-code" }), _jsxs(Text, { dimColor: true, children: [" run ", runState.runId.slice(0, 8), " \u00B7 "] }), _jsx(Text, { children: headerParts.join('  ') }), runTokens > 0 ? (_jsxs(Text, { color: "cyan", children: [" \u00B7 ", formatTokens(runTokens), " tok"] })) : null, finished ? _jsx(Text, { color: "green", children: " \u00B7 finished \u2014 press q to exit" }) : null, floating ? _jsx(Text, { dimColor: true, children: " \u00B7 ctrl+p: dock panel" }) : null, pickerMessage ? _jsxs(Text, { color: "yellow", children: [" \u00B7 ", pickerMessage] }) : null] }), _jsx(Box, { flexDirection: "column", height: canvasHeight, children: canvasLines.map((line, i) => (_jsx(Text, { children: line || ' ' }, i))) }), discussActive && discussState ? (_jsxs(Box, { ...panelBoxProps, children: [_jsx(PanelTitle, { children: _jsxs(Text, { bold: true, color: "yellow", wrap: "truncate-end", children: ["Discussion \u2014 ", discussState.nodeId, discussState.topic ? `: ${discussState.topic}` : '', !discussWindow.following ? (_jsxs(Text, { dimColor: true, children: [' ', "(", discussWindow.start, " above", discussRows.length - discussWindow.end > 0
                                            ? `, ${discussRows.length - discussWindow.end} below`
                                            : '', ")"] })) : null] }) }), _jsx(Box, { flexDirection: "column", flexGrow: 1, justifyContent: "flex-end", overflow: "hidden", children: discussRows.slice(discussWindow.start, discussWindow.end).map((row) => (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: row.color, children: row.prefix }), row.segments.map((segment, i) => (_jsx(Text, { ...segmentStyle(segment), children: segment.text }, i)))] }, row.key))) }), _jsx(Text, { wrap: "truncate-end", children: discussState.awaitingUser ? (_jsxs(_Fragment, { children: [_jsx(Text, { color: "cyan", children: '> ' }), inputBuffer.slice(Math.max(0, inputBuffer.length - discussInputWidth)), _jsx(Text, { inverse: true, children: " " })] })) : (_jsx(Text, { dimColor: true, children: "\u2026 agent is thinking" })) }), _jsx(PanelFooter, { hint: "enter: send \u00B7 /done: finish \u00B7 PgUp/PgDn: scroll \u00B7 drag \u283F/edge: move \u00B7 \u21F2: resize" })] })) : pendingConvergence ? (_jsxs(Box, { ...panelBoxProps, children: [_jsx(PanelTitle, { children: _jsxs(Text, { bold: true, color: "yellow", wrap: "truncate-end", children: ["Convergence \u2014 ", pendingConvergence.req.nodeId, " (", pendingConvergence.req.mode, pendingConvergence.req.mode === 'compare'
                                    ? ': pick exactly one'
                                    : ': pick one or more', ")"] }) }), _jsx(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", children: pendingConvergence.req.branches.map((branch, i) => (_jsxs(Text, { wrap: "truncate-end", children: [_jsxs(Text, { ...(i === convCursor ? { color: 'cyan' } : {}), children: [i === convCursor ? '❯ ' : '  ', convSelected.has(branch.instanceId) ? '[x] ' : '[ ] ', branch.instanceId, " (", branch.branch, ") ", branch.status === 'done' ? '●' : '✖', ' '] }), _jsx(Text, { dimColor: true, children: branch.diffSummary.split('\n').at(-1) ?? '' })] }, branch.instanceId))) }), _jsx(PanelFooter, { hint: "\u2191/\u2193: move \u00B7 space: select \u00B7 enter: confirm \u00B7 drag \u283F/edge: move \u00B7 \u21F2: resize" })] })) : pendingApproval ? (_jsxs(Box, { ...panelBoxProps, children: [_jsx(PanelTitle, { children: _jsxs(Text, { bold: true, color: "yellow", wrap: "truncate-end", children: ["Approval \u2014 ", pendingApproval.req.title] }) }), pendingApproval.req.pushTarget ? (_jsxs(Text, { color: "red", children: ["On approval, `", pendingApproval.req.pushTarget.nodeId, "` will push to", ' ', pendingApproval.req.pushTarget.remote, "/", pendingApproval.req.pushTarget.branch] })) : null, _jsxs(Text, { dimColor: true, children: ["upstream: ", pendingApproval.req.upstreamSummaries.map((u) => u.nodeId).join(', ') || '—'] }), _jsx(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", children: (() => {
                            const lines = pendingApproval.req.diffs.flatMap((d) => [
                                ...(d.label ? [`── ${d.label} ──`] : []),
                                ...(d.diff.length > 0 ? d.diff.split('\n') : ['(no changes)']),
                            ]);
                            const visible = Math.max(1, panelHeight - 6);
                            const start = Math.min(diffScroll, Math.max(0, lines.length - visible));
                            return lines.slice(start, start + visible).map((line, i) => (_jsx(Text, { wrap: "truncate-end", ...(line.startsWith('+')
                                    ? { color: 'green' }
                                    : line.startsWith('-')
                                        ? { color: 'red' }
                                        : {}), dimColor: line.startsWith('@@') || line.startsWith('──'), children: line || ' ' }, i)));
                        })() }), _jsx(PanelFooter, { hint: "[a] approve \u00B7 [r] reject \u00B7 j/k: scroll diff \u00B7 drag \u283F/edge: move \u00B7 \u21F2: resize" })] })) : pickerOpen && focusedNode ? (_jsxs(Box, { ...panelBoxProps, children: [_jsx(PanelTitle, { children: _jsxs(Text, { bold: true, color: "yellow", wrap: "truncate-end", children: ["Model \u2014 ", focusedNode.id, " (", focusedNode.type.displayName, ")"] }) }), _jsx(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", children: (() => {
                            const status = runState.nodes[focusedNode.id]?.status;
                            const readOnly = status === 'running' || status === 'done';
                            return (_jsxs(_Fragment, { children: [readOnly ? (_jsxs(Text, { color: "yellow", wrap: "truncate-end", children: [focusedNode.id, " is already ", status, " \u2014 a change here applies the next time it runs, not to ", status === 'running' ? 'the session in flight' : 'this attempt', "."] })) : null, pickerFreeText !== null ? (_jsxs(_Fragment, { children: [_jsxs(Text, { dimColor: true, wrap: "truncate-end", children: ["model list unavailable", pickerModelListState?.status === 'failed' ? `: ${pickerModelListState.error}` : '', ' — type a model id'] }), _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: "cyan", children: '> ' }), pickerFreeText, _jsx(Text, { inverse: true, children: " " })] })] })) : pickerModelListState?.status === 'loaded' ? ((() => {
                                        const models = pickerModelListState.models;
                                        const { start, end } = windowFor(pickerCursor, models.length, 10);
                                        return (_jsxs(_Fragment, { children: [start > 0 ? _jsxs(Text, { dimColor: true, children: [" \u2191 ", start, " more above"] }) : null, models.slice(start, end).map((model, i) => {
                                                    const idx = start + i;
                                                    const current = model === focusedNodeResolvedModel?.model;
                                                    return (_jsxs(Text, { wrap: "truncate-end", ...(idx === pickerCursor ? { color: 'cyan', bold: true } : {}), children: [idx === pickerCursor ? '❯ ' : '  ', current ? '● ' : '  ', model] }, model));
                                                }), end < models.length ? (_jsxs(Text, { dimColor: true, children: [" \u2193 ", models.length - end, " more below"] })) : null] }));
                                    })()) : (_jsx(Text, { dimColor: true, children: "loading models\u2026" }))] }));
                        })() }), _jsx(PanelFooter, { hint: pickerFreeText !== null
                            ? 'enter: confirm · esc: cancel'
                            : '↑/↓: move · enter: select · esc: cancel' })] })) : expanded && focusedNode ? (_jsx(Box, { ...panelBoxProps, children: (() => {
                    const state = runState.nodes[focusedNode.id];
                    const activity = runState.activity.filter((e) => e.nodeId === focusedNode.id);
                    const live = store.liveOutputFor(focusedNode.id);
                    // Agent output is prose, not a table: wrap it to the panel's inner
                    // width (borders + paddingX) so long sentences stay readable
                    // instead of running past the right edge and being cut off.
                    const outputWidth = Math.max(10, activeRect.w - 4);
                    const liveLines = live.length > 0
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
                    return (_jsxs(_Fragment, { children: [_jsx(PanelTitle, { children: _jsxs(Text, { bold: true, wrap: "truncate-end", children: [focusedNode.id, " ", _jsxs(Text, { dimColor: true, children: ["(", focusedNode.type.displayName, ")"] }), ' ', STATUS_GLYPHS[state.status], " ", state.status, state.statusDetail ? _jsxs(Text, { dimColor: true, children: [" \u2014 ", state.statusDetail] }) : null, state.denials > 0 ? (_jsxs(Text, { color: "red", bold: true, children: ['  ', "\u26A0 ", state.denials, " blocked action", state.denials > 1 ? 's' : ''] })) : null] }) }), _jsxs(Box, { flexDirection: "column", flexGrow: 1, overflow: "hidden", children: [_jsxs(Text, { dimColor: true, wrap: "truncate-end", children: ["config: ", JSON.stringify(focusedNode.config)] }), focusedNode.type.hasModelField ? (_jsxs(Text, { dimColor: true, wrap: "truncate-end", children: ["model: ", focusedNodeResolvedModel?.model ?? '(none — provider default)', focusedNodeResolvedModel
                                                ? ` (from ${{ node: 'this node', settings: 'run settings', provider: 'provider default' }[focusedNodeResolvedModel.origin]}) · m: change`
                                                : ''] })) : null, state.tokens || state.startedAt ? (_jsxs(Text, { dimColor: true, wrap: "truncate-end", children: [state.tokens
                                                ? `tokens: ${formatTokens(state.tokens.input)} in` +
                                                    `${state.tokens.cached > 0 ? ` (+${formatTokens(state.tokens.cached)} cached)` : ''}` +
                                                    ` · ${formatTokens(state.tokens.output)} out`
                                                : 'tokens: —', state.startedAt
                                                ? ` · elapsed ${formatDuration((state.endedAt ? Date.parse(state.endedAt) : Date.now()) -
                                                    Date.parse(state.startedAt))}`
                                                : ''] })) : null, (state.priorAttempts?.length ?? 0) > 0 ? (_jsxs(Text, { color: "magenta", wrap: "truncate-end", children: ["attempt ", state.attempt ?? 1, " \u2014 earlier:", ' ', state.priorAttempts.map((a) => `${a.status}${a.detail ? ` (${a.detail})` : ''}`).join(', ')] })) : null, tail(liveLines, outputBudget).map((line, i) => (_jsx(Text, { wrap: "truncate-end", children: line || ' ' }, `o${i}`))), activity.length > 0 ? _jsx(Text, { dimColor: true, children: "\u2500\u2500 activity \u2500\u2500" }) : null, tail(activity, activityBudget).map((entry, i) => (_jsx(Text, { wrap: "truncate-end", ...(entry.decision === 'denied' ? { color: 'red' } : {}), children: formatActivityRow(entry) }, `a${i}`)))] }), _jsx(PanelFooter, { hint: "enter: close \u00B7 tab: focus \u00B7 drag \u283F/edge: move \u00B7 \u21F2: resize" })] }));
                })() })) : (_jsxs(Text, { dimColor: true, children: ["tab: focus \u00B7 enter: details \u00B7 \u2190\u2192\u2191\u2193: pan \u00B7 q: quit", focusedNode ? ` · focused: ${focusedNode.id}` : ''] }))] }));
}
//# sourceMappingURL=App.js.map