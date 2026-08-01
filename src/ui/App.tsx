import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RunStateStore } from '../runstate/store.js';
import type { ActivityEntry, RunState } from '../runstate/types.js';
import type { Workflow } from '../workflow/load.js';
import { gridToLines, renderGraph, STATUS_GLYPHS } from './canvas.js';
import { computeLayout, hitTest, scrollIntoView, type PositionOverrides } from './layout.js';
import { disableMouse, enableMouse, parseMouseEvents } from './mouse.js';
import type { UiInteractionPorts } from './ports.js';

export interface AppProps {
  workflow: Workflow;
  store: RunStateStore;
  ports: UiInteractionPorts;
  onExit: () => void;
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

export function App({ workflow, store, ports, onExit }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();

  const [runState, setRunState] = useState<RunState>(store.snapshot());
  const [, setPortsTick] = useState(0);
  const [focusIdx, setFocusIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState({ ox: 0, oy: 0 });
  const [overrides, setOverrides] = useState<PositionOverrides>(new Map());
  const [inputBuffer, setInputBuffer] = useState('');
  const [convCursor, setConvCursor] = useState(0);
  const [convSelected, setConvSelected] = useState<Set<string>>(new Set());
  const [diffScroll, setDiffScroll] = useState(0);
  const dragRef = useRef<{ id: string; lastX: number; lastY: number } | null>(null);

  useEffect(() => store.subscribe(setRunState), [store]);
  useEffect(() => ports.subscribe(() => setPortsTick((t) => t + 1)), [ports]);

  const columns = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;

  const pendingApproval = ports.pendingApproval;
  const pendingConvergence = ports.pendingConvergence;
  const discussState = ports.discussState;
  const discussActive = discussState?.active ?? false;

  const panelOpen = expanded || pendingApproval !== null || pendingConvergence !== null || discussActive;
  const panelHeight = panelOpen ? Math.max(10, Math.floor(rows * 0.45)) : 2;
  const canvasHeight = Math.max(5, rows - panelHeight - 2);

  const layout = useMemo(() => computeLayout(workflow, overrides), [workflow, overrides]);
  const focusedId = workflow.order[Math.min(focusIdx, workflow.order.length - 1)] ?? null;
  const focusedNode = workflow.nodes.find((n) => n.id === focusedId);

  // Focus scrolls into view (keyboard navigation on graphs larger than the terminal).
  useEffect(() => {
    if (!focusedId) return;
    const box = layout.boxes.get(focusedId);
    if (!box) return;
    setOffset((prev) =>
      scrollIntoView(box, { ...prev, width: columns - 2, height: canvasHeight }),
    );
  }, [focusedId, layout, columns, canvasHeight]);

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

  // Mouse: enhancement layer only. Terminals without mouse reporting simply
  // never emit these sequences; everything stays keyboard-operable.
  useEffect(() => {
    if (!stdin || !stdout.isTTY) return;
    enableMouse(stdout);
    const onData = (data: Buffer | string) => {
      const events = parseMouseEvents(data.toString());
      for (const event of events) {
        const canvasX = event.x + offset.ox;
        const canvasY = event.y - 1 + offset.oy;
        if (event.kind === 'press' && event.button === 0) {
          const id = hitTest(layout, canvasX, canvasY);
          if (id) {
            setFocusIdx(Math.max(0, workflow.order.indexOf(id)));
            dragRef.current = { id, lastX: canvasX, lastY: canvasY };
          }
        } else if (event.kind === 'drag' && dragRef.current) {
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
        }
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      disableMouse(stdout);
    };
  }, [stdin, stdout, layout, offset, workflow.order]);

  useInput((input, key) => {
    // Discussion input mode captures the keyboard.
    if (discussActive && discussState) {
      if (key.return) {
        const text = inputBuffer.trim();
        setInputBuffer('');
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

    // Normal navigation.
    if (key.tab && key.shift) {
      setFocusIdx((i) => (i + workflow.order.length - 1) % workflow.order.length);
    } else if (key.tab) {
      setFocusIdx((i) => (i + 1) % workflow.order.length);
    } else if (key.return) {
      setExpanded((e) => !e);
    } else if (key.leftArrow) {
      setOffset((o) => ({ ...o, ox: Math.max(0, o.ox - 4) }));
    } else if (key.rightArrow) {
      setOffset((o) => ({ ...o, ox: o.ox + 4 }));
    } else if (key.upArrow) {
      setOffset((o) => ({ ...o, oy: Math.max(0, o.oy - 2) }));
    } else if (key.downArrow) {
      setOffset((o) => ({ ...o, oy: o.oy + 2 }));
    } else if (input === 'q') {
      onExit();
      exit();
    }
  });

  const grid = useMemo(
    () => renderGraph(workflow, layout, runState, focusedId),
    [workflow, layout, runState, focusedId],
  );
  const canvasLines = useMemo(
    () => gridToLines(grid, { ...offset, width: columns - 2, height: canvasHeight }),
    [grid, offset, columns, canvasHeight],
  );

  const statusCounts = Object.values(runState.nodes).reduce<Record<string, number>>(
    (acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }),
    {},
  );
  const finished = runState.finishedAt !== undefined;
  const headerParts = Object.entries(statusCounts).map(
    ([status, count]) => `${STATUS_GLYPHS[status as keyof typeof STATUS_GLYPHS]} ${count}`,
  );

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">
          flow-code
        </Text>
        <Text dimColor> run {runState.runId.slice(0, 8)} · </Text>
        <Text>{headerParts.join('  ')}</Text>
        {finished ? <Text color="green"> · finished — press q to exit</Text> : null}
      </Text>
      <Box flexDirection="column" height={canvasHeight}>
        {canvasLines.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
      {discussActive && discussState ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} height={panelHeight}>
          <Text bold color="yellow">
            Discussion — {discussState.nodeId}
            {discussState.topic ? `: ${discussState.topic}` : ''}
          </Text>
          {tail(discussState.transcript, panelHeight - 5).map((entry, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={entry.role === 'user' ? 'cyan' : 'green'}>
                {entry.role === 'user' ? 'you' : 'agent'}:{' '}
              </Text>
              {entry.text.split('\n')[0]}
            </Text>
          ))}
          <Text>
            {discussState.awaitingUser ? (
              <>
                <Text color="cyan">{'> '}</Text>
                {inputBuffer}
                <Text inverse> </Text>
              </>
            ) : (
              <Text dimColor>… agent is thinking</Text>
            )}
          </Text>
          <Text dimColor>enter: send · type /done to finish the discussion</Text>
        </Box>
      ) : pendingConvergence ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} height={panelHeight}>
          <Text bold color="yellow">
            Convergence — {pendingConvergence.req.nodeId} ({pendingConvergence.req.mode}
            {pendingConvergence.req.mode === 'compare' ? ': pick exactly one' : ': pick one or more'}
            )
          </Text>
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
          <Text dimColor>↑/↓: move · space: select · enter: confirm</Text>
        </Box>
      ) : pendingApproval ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} height={panelHeight}>
          <Text bold color="yellow">
            Approval — {pendingApproval.req.title}
          </Text>
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
          <Text dimColor>[a] approve · [r] reject · j/k: scroll diff</Text>
        </Box>
      ) : expanded && focusedNode ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} height={panelHeight}>
          {(() => {
            const state = runState.nodes[focusedNode.id]!;
            const activity = runState.activity.filter((e) => e.nodeId === focusedNode.id);
            const live = store.liveOutputFor(focusedNode.id);
            const liveLines = live.length > 0 ? live.trimEnd().split('\n') : [];
            const outputBudget = Math.max(1, Math.floor((panelHeight - 5) / 2));
            const activityBudget = Math.max(1, panelHeight - 5 - outputBudget);
            return (
              <>
                <Text bold>
                  {focusedNode.id} <Text dimColor>({focusedNode.type.displayName})</Text>{' '}
                  {STATUS_GLYPHS[state.status]} {state.status}
                  {state.statusDetail ? <Text dimColor> — {state.statusDetail}</Text> : null}
                  {state.denials > 0 ? (
                    <Text color="red" bold>
                      {'  '}⚠ {state.denials} blocked action{state.denials > 1 ? 's' : ''}
                    </Text>
                  ) : null}
                </Text>
                <Text dimColor wrap="truncate-end">
                  config: {JSON.stringify(focusedNode.config)}
                </Text>
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
              </>
            );
          })()}
        </Box>
      ) : (
        <Text dimColor>
          tab: focus · enter: details · ←→↑↓: pan · q: quit
          {focusedNode ? ` · focused: ${focusedNode.id}` : ''}
        </Text>
      )}
    </Box>
  );
}
