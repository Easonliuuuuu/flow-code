/**
 * `flow-code status` — a live run, compressed to one or two rows of text for a
 * surface flow-code does not own.
 *
 * The canvas cannot follow a user into an agent CLI session: that transcript is
 * append-only and the input line belongs to the host, so a graph drawn into it
 * is a snapshot that is wrong a second later. What those hosts do offer is a
 * status bar — a command they re-run on every event, at a width they choose.
 * This module is what such a command prints.
 *
 * Three constraints shape everything here, and all three come from the caller
 * rather than from us: it is re-run constantly (so: one read, no writes, no
 * subprocess), it may be cancelled mid-flight (so: no partial side effects),
 * and it is displayed rather than read (so: a stack trace where a summary
 * belongs is a broken status bar the user cannot debug from there — every
 * failure renders as "no run" and exits zero).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { driverLiveness } from '../runstate/persist.js';
import { liveRuns } from '../runstate/watch.js';
import { budgetedTokens, sumTokens, type NodeStatus, type RunState } from '../runstate/types.js';
import { STATUS_GLYPHS } from '../ui/canvas.js';
import { columnWidth, fitText } from '../ui/textwrap.js';

/**
 * How much of flow-code's enforcement was in force for a run.
 *
 * `engine` is a run flow-code executed itself — the only tier that exists in
 * the product today, and the default for any run document that does not say
 * otherwise. The other two are written by `add-guest-mode-reporter`, which owns
 * the field: `hooks` is a host session with flow-code's enforcement active,
 * `reported` is self-reporting with none. This module reads the field
 * defensively rather than waiting for it, because the alternative is a status
 * surface that quietly implies guarantees a run never carried.
 */
export type EnforcementTier = 'engine' | 'hooks' | 'reported';

const TIERS = new Set<EnforcementTier>(['engine', 'hooks', 'reported']);

export type SummaryKind =
  /** No run recorded for this directory at all. */
  | 'none'
  /** A node is blocked on the user. Outranks everything: the run is stopped and the human is why. */
  | 'waiting'
  | 'running'
  | 'error'
  /** Attached to a live run with nothing started yet. */
  | 'idle'
  | 'finished'
  | 'interrupted'
  /** Unfinished, but the process that was driving it is gone. */
  | 'undriven'
  /** Unfinished, and this machine cannot say whether anything is still driving it. */
  | 'unverifiable';

export interface SummaryNode {
  id: string;
  status: NodeStatus;
}

export interface RunSummary {
  kind: SummaryKind;
  runId?: string;
  /** The one node worth naming, when there is one. */
  node?: string;
  detail?: string;
  elapsedMs?: number;
  /** Only when past the first attempt — a loop-back has re-run this node. */
  attempt?: number;
  subagents?: number;
  done: number;
  total: number;
  /**
   * Undefined means unavailable, never zero. A run whose tier does not account
   * for tokens has not spent nothing; we do not know what it spent.
   */
  tokens?: number;
  budgetPct?: number;
  denials: number;
  tier: EnforcementTier;
  nodes: SummaryNode[];
  /** Set only when more than one run in the repository is live, so one row is not read as the only run. */
  liveRuns?: number;
}

/** Terminal statuses: counted as progress rather than as work outstanding. */
const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'skipped']);

/**
 * The run document's own claim about which guarantees applied. Absent means
 * `engine`: every run written before tiers existed was engine-driven, and
 * treating an unknown value as the strongest tier would be the one direction
 * this must never round.
 */
function tierOf(state: RunState): EnforcementTier {
  const claimed = (state as RunState & { enforcement?: { tier?: string } }).enforcement?.tier;
  if (claimed === undefined) return 'engine';
  return TIERS.has(claimed as EnforcementTier) ? (claimed as EnforcementTier) : 'reported';
}

/**
 * Spend, or undefined when the run's tier cannot account for it. A `hooks` run
 * that recorded nothing is unmeasured rather than free — flow-code did not run
 * the session, so a zero there is an absence of data, not an observation.
 */
function spendOf(state: RunState, tier: EnforcementTier): number | undefined {
  if (tier === 'reported') return undefined;
  const total = Object.values(state.nodes).reduce((sum, n) => sum + sumTokens(n.tokens), 0);
  if (total === 0 && tier !== 'engine') return undefined;
  return total;
}

function budgetPctOf(state: RunState, tier: EnforcementTier): number | undefined {
  const cap = state.graph?.settings?.budget?.tokensPerRun;
  if (!cap || tier === 'reported') return undefined;
  const spent = Object.values(state.nodes).reduce((sum, n) => sum + budgetedTokens(n.tokens), 0);
  return Math.round((spent / cap) * 100);
}

/** Node order as the run recorded it; a document without a graph falls back to insertion order. */
function orderedNodes(state: RunState): SummaryNode[] {
  const ids = state.graph?.nodes.map((n) => n.id) ?? Object.keys(state.nodes);
  return ids.map((id) => ({ id, status: state.nodes[id]?.status ?? 'idle' }));
}

/**
 * The one node the summary names, in the order a person needs them: a waiting
 * node has stopped the run and is asking for something; a running node is the
 * answer to "what is it doing"; an error is only the headline once nothing is
 * still moving, because under a loop-back a failed node is often already being
 * retried further up the graph.
 */
function focusNode(nodes: SummaryNode[]): SummaryNode | undefined {
  return (
    nodes.find((n) => n.status === 'waiting') ??
    nodes.find((n) => n.status === 'running') ??
    nodes.find((n) => n.status === 'error')
  );
}

export function summarize(state: RunState | undefined, now: number = Date.now()): RunSummary {
  if (!state) {
    return { kind: 'none', done: 0, total: 0, denials: 0, tier: 'engine', nodes: [] };
  }

  const nodes = orderedNodes(state);
  const tier = tierOf(state);
  const tokens = spendOf(state, tier);
  const budgetPct = budgetPctOf(state, tier);
  const base = {
    done: nodes.filter((n) => SETTLED.has(n.status)).length,
    total: nodes.length,
    denials: Object.values(state.nodes).reduce((sum, n) => sum + (n.denials ?? 0), 0),
    tier,
    nodes,
    ...(state.runId ? { runId: state.runId } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(budgetPct !== undefined ? { budgetPct } : {}),
  };

  if (state.finishedAt !== undefined) {
    return { ...base, kind: state.interrupted ? 'interrupted' : 'finished' };
  }
  // Unfinished and nobody is driving it: the last status the file recorded is
  // frozen, not current. Saying "running" here is the one lie that reliably
  // costs someone ten minutes — and saying it about a run this machine cannot
  // answer for is the same lie with less excuse, so that case says so instead.
  const liveness = driverLiveness(state);
  if (liveness !== 'live') {
    const stalled = focusNode(nodes);
    return {
      ...base,
      kind: liveness === 'dead' ? 'undriven' : 'unverifiable',
      ...(stalled ? { node: stalled.id } : {}),
    };
  }

  const focus = focusNode(nodes);
  if (!focus) return { ...base, kind: 'idle' };

  const node = state.nodes[focus.id];
  const startedAt = node?.startedAt ? Date.parse(node.startedAt) : undefined;
  const elapsedMs = focus.status === 'running' && startedAt !== undefined ? Math.max(0, now - startedAt) : undefined;
  const attempt = (node?.attempt ?? 1) > 1 ? node?.attempt : undefined;
  return {
    ...base,
    kind: focus.status as 'waiting' | 'running' | 'error',
    node: focus.id,
    ...(node?.statusDetail !== undefined ? { detail: node.statusDetail } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(node?.subagents ? { subagents: node.subagents } : {}),
  };
}

// ------------------------------------------------------------- rendering ----

type Style = 'plain' | 'dim' | 'cyan' | 'yellow' | 'green' | 'red';

interface Span {
  text: string;
  style: Style;
}

const ANSI: Record<Style, string> = {
  plain: '',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

/** Mirrors the canvas's status styling so one run does not read as two different things in two places. */
const STATUS_STYLE: Record<NodeStatus, Style> = {
  idle: 'dim',
  running: 'cyan',
  waiting: 'yellow',
  done: 'green',
  error: 'red',
  skipped: 'dim',
};

const KIND_STYLE: Record<SummaryKind, Style> = {
  none: 'dim',
  waiting: 'yellow',
  running: 'cyan',
  error: 'red',
  idle: 'dim',
  finished: 'green',
  interrupted: 'yellow',
  undriven: 'red',
  unverifiable: 'yellow',
};

function paint(spans: Span[], color: boolean): string {
  if (!color) return spans.map((s) => s.text).join('');
  return spans.map((s) => (s.style === 'plain' ? s.text : `${ANSI[s.style]}${s.text}\x1b[0m`)).join('');
}

function widthOf(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + columnWidth(s.text), 0);
}

export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * The text that survives to the narrowest rung: what the run needs, or why it
 * is not asking for anything. Defaults mirror the node card's phrasing, so the
 * strip and the canvas describe a node the same way.
 */
export function headlineText(s: RunSummary): string {
  switch (s.kind) {
    case 'none':
      return 'no run';
    case 'idle':
      return 'starting';
    case 'finished':
      return 'finished';
    case 'interrupted':
      return 'interrupted';
    case 'undriven':
      return s.node ? `${s.node} — driver gone` : 'driver gone';
    case 'unverifiable':
      return s.node ? `${s.node} — driver unknown` : 'driver unknown';
    case 'waiting':
      return `${s.node} ${s.detail ?? 'waiting for you'}`;
    case 'error':
      return `${s.node} ${s.detail ?? 'failed'}`;
    case 'running': {
      const bits = [s.node, s.detail ?? 'thinking'];
      if (s.elapsedMs !== undefined) bits.push(formatElapsed(s.elapsedMs));
      if (s.attempt) bits.push(`try ${s.attempt}`);
      if (s.subagents) bits.push(`+${s.subagents} sub`);
      return bits.join(' ');
    }
  }
}

function headlineSpans(s: RunSummary): Span[] {
  const style = KIND_STYLE[s.kind];
  const glyph = s.kind === 'none' || s.kind === 'idle' ? undefined : STATUS_GLYPHS[statusForKind(s.kind)];
  const spans: Span[] = [];
  if (glyph) spans.push({ text: `${glyph} `, style });
  spans.push({ text: headlineText(s), style });
  return spans;
}

/** Which node status a summary kind reads as, for glyph purposes only. */
function statusForKind(kind: SummaryKind): NodeStatus {
  switch (kind) {
    case 'waiting':
      return 'waiting';
    case 'running':
      return 'running';
    case 'error':
    case 'undriven':
      return 'error';
    case 'unverifiable':
      return 'waiting';
    case 'finished':
      return 'done';
    case 'interrupted':
      return 'skipped';
    default:
      return 'idle';
  }
}

function chainSpans(s: RunSummary, labels: boolean): Span[] {
  const spans: Span[] = [];
  s.nodes.forEach((n, i) => {
    const style = STATUS_STYLE[n.status];
    if (labels) {
      if (i > 0) spans.push({ text: ' ', style: 'plain' });
      spans.push({ text: `${STATUS_GLYPHS[n.status]}${n.id}`, style });
    } else {
      spans.push({ text: STATUS_GLYPHS[n.status], style });
    }
  });
  return spans;
}

function metaSpans(s: RunSummary): Span[] {
  // Nothing to be quantitative about. "no run · spend n/a" reads as a broken
  // meter rather than as an absent one, which is the opposite of the point.
  if (s.kind === 'none') return [];
  const parts: Span[] = [];
  const push = (text: string, style: Style = 'dim') => {
    if (parts.length > 0) parts.push({ text: ' · ', style: 'dim' });
    parts.push({ text, style });
  };
  if (s.total > 0) push(`${s.done}/${s.total}`);
  push(s.tokens === undefined ? 'spend n/a' : `${formatCount(s.tokens)} tok`);
  if (s.budgetPct !== undefined) push(`${s.budgetPct}% budget`, s.budgetPct >= 80 ? 'red' : 'dim');
  if (s.denials > 0) push(`${s.denials} blocked`, 'yellow');
  // One row cannot name several runs; it can at least refuse to imply it is
  // describing the only one. `flow-code runs` is where they get named.
  if (s.liveRuns && s.liveRuns > 1) push(`${s.liveRuns} live runs`, 'yellow');
  // Only worth columns when it is not the tier every run used to have.
  if (s.tier !== 'engine') push(s.tier === 'hooks' ? 'host session' : 'self-reported', 'yellow');
  return parts;
}

function joinSpans(groups: Span[][], separator: string): Span[] {
  const out: Span[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push({ text: separator, style: 'plain' });
    out.push(...group);
  }
  return out;
}

export interface RenderOptions {
  width: number;
  color?: boolean;
}

/**
 * One row, never more — this is what gets embedded in a status surface someone
 * else owns, so it may not claim a second line.
 *
 * The ladder drops context before it drops the blocking node: labels before
 * glyphs, glyphs before numbers, and the headline last. Truncation is the final
 * rung rather than the mechanism, because `fitText` cuts from the right, which
 * is exactly where the reason lives.
 */
export function renderLine(summary: RunSummary, opts: RenderOptions): string {
  const { width, color = false } = opts;
  if (width <= 0) return '';

  const headline = headlineSpans(summary);
  const meta = metaSpans(summary);
  const rungs: Span[][] = [
    joinSpans([chainSpans(summary, true), headline, meta], '  '),
    joinSpans([chainSpans(summary, false), headline, meta], '  '),
    joinSpans([chainSpans(summary, false), headline], '  '),
    headline,
  ];

  for (const rung of rungs) {
    if (widthOf(rung) <= width) return paint(rung, color);
  }
  return paint([{ text: fitText(headlineText(summary), width), style: KIND_STYLE[summary.kind] }], color);
}

/**
 * The human-facing form: the same content, allowed a second row for the
 * labelled chain when the terminal is wide enough to make it worth reading.
 */
export function renderBlock(summary: RunSummary, opts: RenderOptions): string[] {
  const { width, color = false } = opts;
  const head = joinSpans([[{ text: 'flow-code', style: 'dim' }], headlineSpans(summary), metaSpans(summary)], '  ');
  const chain = chainSpans(summary, true);
  if (summary.nodes.length === 0 || widthOf(chain) + 2 > width || widthOf(head) > width) {
    return [renderLine(summary, opts)];
  }
  return [paint(head, color), `  ${paint(chain, color)}`];
}

// ------------------------------------------------------------- attention ----

export interface Attention {
  /**
   * Identifies *which* thing needs attention, not when it was noticed. Stable
   * across repeated checks of the same blocked node, and different once a
   * loop-back re-runs it — so a consumer that remembers the last token it saw
   * announces a given block once rather than on every poll.
   */
  token: string;
  message: string;
}

/**
 * The transitions a passive strip can be missed on. Deliberately stateless:
 * flow-code never writes to say what it has already announced, so the caller
 * holds the last token it saw. That keeps this command side-effect free even
 * when it is driving a notification.
 */
export function attention(summary: RunSummary): Attention | undefined {
  if (summary.kind !== 'waiting' && summary.kind !== 'error' && summary.kind !== 'undriven') return undefined;
  const token = [summary.runId ?? '-', summary.kind, summary.node ?? '-', summary.attempt ?? 1].join(':');
  return { token, message: `flow-code: ${headlineText(summary)}` };
}

/** The announcement to make, given the last one the caller made. */
export function announcement(summary: RunSummary, lastToken?: string): Attention | undefined {
  const current = attention(summary);
  if (!current || current.token === lastToken) return undefined;
  return current;
}

// ----------------------------------------------------------------- entry ----

/**
 * The nearest enclosing project, found by walking up for `.flow-code`.
 *
 * Deliberately not `git rev-parse`: this runs on every event of whatever is
 * displaying it, and a subprocess per keystroke is a cost the caller cannot
 * see and did not agree to. The run directory is what we actually need anyway.
 */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    try {
      if (statSync(join(dir, '.flow-code')).isDirectory()) return dir;
    } catch {
      // Not here; keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The newest run document, read once.
 *
 * `latestRunState` in `runstate/watch.ts` does the same job for the viewer, but
 * it resolves against a repo root this command may not have and treats an
 * unreadable file as a reason to return nothing — which is the behaviour we
 * want, so the difference here is only where the directory comes from.
 */
function readNewestRun(projectRoot: string): RunState | undefined {
  const dir = join(projectRoot, '.flow-code', 'runs');
  let newest: { path: string; mtimeMs: number } | undefined;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      try {
        const { mtimeMs } = statSync(path);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      } catch {
        // Vanished between readdir and stat (a `.tmp` mid-rename): skip it.
      }
    }
  } catch {
    return undefined;
  }
  if (!newest) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(newest.path, 'utf8')) as RunState;
    // A half-written document parses into something that is not a run. Rather
    // than render its fragments as state, treat it as nothing to report.
    return parsed && typeof parsed === 'object' && parsed.nodes ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the current run for `dir` and summarizes it. Never throws, never writes. */
export function statusFor(dir: string, now: number = Date.now()): RunSummary {
  const root = findProjectRoot(dir);
  const summary = summarize(root ? readNewestRun(root) : undefined, now);
  // Only worth a second look when the run we found is actually moving: that is
  // the case where reading one row as "the run" would mislead. Everything else
  // stays at one file read, which is what makes this cheap enough to re-run on
  // every event of whatever is displaying it.
  if (!root || !MOVING.has(summary.kind)) return summary;
  const live = liveRuns(root).length;
  return live > 1 ? { ...summary, liveRuns: live } : summary;
}

/** Kinds where another live run in the same repository would change how this row reads. */
const MOVING: ReadonlySet<SummaryKind> = new Set<SummaryKind>(['waiting', 'running', 'idle']);

const SCRIPT = `#!/usr/bin/env bash
# flow-code status line. Prints one row describing this repo's current run.
#
# Register it as your host's status-line command (Claude Code:
# ~/.claude/settings.json -> "statusLine": { "type": "command", "command":
# "~/.claude/flow-code-status.sh", "refreshInterval": 1 }). If you already have
# a status line, don't replace it — call \`flow-code status --line --dir "$DIR"\`
# from inside the script you have and paste the output into your own row.
input=$(cat)

# jq is not guaranteed to be installed; python3 effectively is. Prefer jq when
# it is there, fall back rather than printing nothing on a machine without it.
if command -v jq >/dev/null 2>&1; then
  DIR=$(printf '%s' "$input" | jq -r '.workspace.current_dir // "."')
else
  PY='import json,sys; print(json.load(sys.stdin).get("workspace",{}).get("current_dir","."))'
  DIR=$(printf '%s' "$input" | python3 -c "$PY" 2>/dev/null || echo .)
fi

exec flow-code status --line --dir "$DIR" --width "\${COLUMNS:-100}"
`;

function parseWidth(args: string[], fallback: number): number {
  const i = args.indexOf('--width');
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseDir(args: string[]): string {
  const i = args.indexOf('--dir');
  const value = i === -1 ? undefined : args[i + 1];
  return value && !value.startsWith('--') ? value : process.cwd();
}

export async function cmdStatus(args: string[]): Promise<void> {
  if (args.includes('--script')) {
    process.stdout.write(SCRIPT);
    return;
  }

  const summary = statusFor(parseDir(args));

  if (args.includes('--json')) {
    const last = args.indexOf('--since') === -1 ? undefined : args[args.indexOf('--since') + 1];
    console.log(JSON.stringify({ summary, attention: announcement(summary, last) ?? null }, null, 2));
    return;
  }

  // Colour by default: the surfaces this is written for render ANSI but are
  // not TTYs, so a `isTTY` check would strip colour exactly where it is wanted.
  const color = !args.includes('--no-color') && process.env.NO_COLOR === undefined;
  const width = parseWidth(args, process.stdout.columns || 100);
  const rows = args.includes('--line')
    ? [renderLine(summary, { width, color })]
    : renderBlock(summary, { width, color });
  for (const row of rows) console.log(row);
}
