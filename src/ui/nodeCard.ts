import type { ActivityEntry, NodeRunState } from '../runstate/types.js';
import type { WorkflowNode } from '../workflow/load.js';

/**
 * The content of a node's box beyond its title — the part that makes a card
 * worth looking at while a run is in flight. Every function here is pure and
 * takes `now`/`frame` explicitly so the canvas stays snapshot-testable.
 */

/** Braille spinner, one frame per animation tick, for nodes that are running. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(frame: number): string {
  return SPINNER_FRAMES[Math.abs(Math.trunc(frame)) % SPINNER_FRAMES.length]!;
}

/**
 * Trailing ellipsis that grows 0→3 dots and back to 0, padded to a constant
 * width so the text in front of it never shifts between frames.
 */
export function ellipsis(frame: number): string {
  const dots = Math.abs(Math.trunc(frame / 3)) % 4;
  return '.'.repeat(dots).padEnd(3);
}

/** `842`, `12.4k`, `1.2M` — short enough to sit inside a node box. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `4s`, `1m04s`, `2h07m` — fixed-ish width so a ticking clock doesn't jitter. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function firstLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function config(node: WorkflowNode): Record<string, unknown> {
  return (node.config ?? {}) as Record<string, unknown>;
}

/**
 * What this node *will* do, drawn while it hasn't run yet: the interesting
 * part of its config, not its type name repeated back. A node type with
 * nothing configurable falls back to a one-line description of its job, so
 * the row is never empty.
 */
export function plannedSummary(node: WorkflowNode): string {
  const c = config(node);
  switch (node.type.id) {
    case 'discuss':
      return firstLine(typeof c['topic'] === 'string' ? c['topic'] : 'settle intent and constraints');
    case 'implement':
      return firstLine(typeof c['instructions'] === 'string' ? c['instructions'] : 'write the code');
    case 'test': {
      const commands = Array.isArray(c['commands']) ? (c['commands'] as string[]) : [];
      return firstLine(commands.join(' · ') || 'run test commands');
    }
    case 'validate':
      return firstLine(
        typeof c['instructions'] === 'string' ? c['instructions'] : 'check the work matches intent',
      );
    case 'review':
      return firstLine(
        typeof c['instructions'] === 'string' ? c['instructions'] : 'critique the pending diff',
      );
    case 'git-ops': {
      const push = c['push'] as { remote?: string; branch?: string } | undefined;
      if (push?.remote && push.branch) return `commit + push → ${push.remote}/${push.branch}`;
      return firstLine(typeof c['commitMessage'] === 'string' ? `commit: ${c['commitMessage']}` : 'commit only');
    }
    case 'worktree-agent': {
      const instances = Array.isArray(c['instances']) ? c['instances'] : [];
      return `${String(c['mode'] ?? '?')} × ${instances.length} worktrees`;
    }
    case 'approval-gate':
      return firstLine(typeof c['title'] === 'string' ? c['title'] : 'waits for your approval');
    default:
      return firstLine(node.type.description);
  }
}

/**
 * What this node actually produced, drawn once it's finished: the headline of
 * its output, so a completed graph reads as a report rather than a row of
 * green dots.
 */
export function outcomeSummary(node: WorkflowNode, output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  switch (node.type.id) {
    case 'discuss':
      return typeof o['conclusion'] === 'string' ? firstLine(o['conclusion']) : null;
    case 'implement': {
      const files = Array.isArray(o['changedFiles']) ? o['changedFiles'].length : 0;
      const summary = typeof o['summary'] === 'string' ? o['summary'] : '';
      const filesPart = `${files} file${files === 1 ? '' : 's'} changed`;
      return summary ? firstLine(`${filesPart} — ${summary}`) : filesPart;
    }
    case 'test': {
      const commands = Array.isArray(o['commands']) ? o['commands'].length : 0;
      return o['passed'] === true
        ? `${commands} command${commands === 1 ? '' : 's'} passed`
        : 'command failed';
    }
    case 'validate':
      return o['verdict'] === 'pass' ? 'verdict: pass' : `verdict: fail${o['notes'] ? ` — ${firstLine(String(o['notes']), 40)}` : ''}`;
    case 'review': {
      const findings = Array.isArray(o['findings']) ? o['findings'].length : 0;
      return `${o['verdict'] === 'pass' ? 'pass' : 'fail'} · ${findings} finding${findings === 1 ? '' : 's'}`;
    }
    case 'git-ops': {
      if (o['pushed'] === true) return `pushed → ${String(o['remote'])}/${String(o['branch'])}`;
      if (o['committed'] === true) return `committed ${String(o['commit'] ?? '').slice(0, 7)}`.trimEnd();
      return 'nothing to commit';
    }
    case 'worktree-agent': {
      const branches = Array.isArray(o['branches']) ? o['branches'].length : 0;
      const selected = Array.isArray(o['selected']) ? o['selected'].length : 0;
      return `${selected}/${branches} branch${branches === 1 ? '' : 'es'} kept`;
    }
    case 'approval-gate':
      return o['decision'] === 'approved' ? 'approved' : 'rejected';
    default:
      return null;
  }
}

/**
 * The line under a node's title: what it's doing right now while it runs,
 * what it produced once it's done, and what it's going to do before that.
 * Running nodes prefer their most recent tool call — that's the closest thing
 * the UI has to watching over the agent's shoulder.
 */
export function nodeSubtitle(
  node: WorkflowNode,
  state: NodeRunState,
  activity: ActivityEntry[],
  frame: number,
): string {
  switch (state.status) {
    case 'running': {
      const last = activity.at(-1);
      if (last) {
        const denied = last.decision === 'denied' ? '⚠ ' : '';
        return `${denied}${last.tool} ${firstLine(last.summary, 40)}`;
      }
      return `${state.statusDetail ? firstLine(state.statusDetail, 40) : 'thinking'}${ellipsis(frame)}`;
    }
    case 'waiting':
      return firstLine(state.statusDetail ?? 'waiting for you', 44);
    case 'error':
      return firstLine(state.statusDetail ?? 'failed', 44);
    case 'done':
      return outcomeSummary(node, state.output) ?? plannedSummary(node);
    case 'skipped':
      return firstLine(state.statusDetail ?? 'skipped', 44);
    default:
      return plannedSummary(node);
  }
}

/**
 * The metrics line: tokens consumed so far and wall-clock time, both live
 * while the node runs and frozen at its final value afterwards. Empty for a
 * node that hasn't started — there is nothing to measure yet.
 */
export function nodeMetrics(state: NodeRunState, now: number): string {
  const parts: string[] = [];
  if (state.tokens) {
    const prompt = state.tokens.input + state.tokens.cached;
    parts.push(`↑${formatTokens(prompt)} ↓${formatTokens(state.tokens.output)}`);
  }
  if (state.startedAt) {
    const end = state.endedAt ? Date.parse(state.endedAt) : now;
    parts.push(formatDuration(end - Date.parse(state.startedAt)));
  }
  return parts.join(' · ');
}

/** Every token the run has consumed, for the header total. */
export function totalTokens(nodes: Record<string, NodeRunState>): number {
  return Object.values(nodes).reduce(
    (sum, n) => sum + (n.tokens ? n.tokens.input + n.tokens.cached + n.tokens.output : 0),
    0,
  );
}
