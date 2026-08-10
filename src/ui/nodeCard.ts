import { promptTokens, sumTokens } from '../runstate/types.js';
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

/**
 * `⑂2` when a node has subagents running, empty otherwise.
 *
 * In-flight, not a total: it answers "is this node delegating right now",
 * which is what makes a card doing a lot of work legible. It goes last on the
 * title row so that when the row is truncated this is what falls off, never
 * the node's status or identity.
 */
export function delegationBadge(state: NodeRunState): string {
  const count = state.subagents ?? 0;
  return count > 0 ? ` ⑂${count}` : '';
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
    case 'spec': {
      const criteria = Array.isArray(c['acceptanceCriteria']) ? c['acceptanceCriteria'].length : 0;
      if (criteria > 0) return `${criteria} acceptance criteri${criteria === 1 ? 'on' : 'a'} (given)`;
      return firstLine(typeof c['title'] === 'string' ? c['title'] : 'write the spec to verify against');
    }
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
    case 'spec': {
      const criteria = Array.isArray(o['acceptanceCriteria']) ? o['acceptanceCriteria'].length : 0;
      return `${criteria} acceptance criteri${criteria === 1 ? 'on' : 'a'}`;
    }
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
    case 'validate': {
      // With criteria in play, "3/4 criteria met" says more than a verdict.
      const criteria = Array.isArray(o['criteria'])
        ? (o['criteria'] as Array<{ met?: unknown }>)
        : [];
      if (criteria.length > 0) {
        const met = criteria.filter((c) => c.met === true).length;
        return `${met}/${criteria.length} criteria met`;
      }
      return o['verdict'] === 'pass'
        ? 'verdict: pass'
        : `verdict: fail${o['notes'] ? ` — ${firstLine(String(o['notes']), 40)}` : ''}`;
    }
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
  /** Characters the card can actually show — the box is sized by the layout,
   * so eliding to a hardcoded guess either wasted space or cut text the box
   * had room for. */
  width = 44,
): string {
  switch (state.status) {
    case 'running': {
      const last = activity.at(-1);
      if (last) {
        const denied = last.decision === 'denied' ? '⚠ ' : '';
        const prefix = `${denied}${last.tool} `;
        return `${prefix}${firstLine(last.summary, Math.max(4, width - prefix.length))}`;
      }
      // The ellipsis animation is a fixed 3 columns on the end of the line.
      const detailWidth = Math.max(4, width - 3);
      return `${state.statusDetail ? firstLine(state.statusDetail, detailWidth) : 'thinking'}${ellipsis(frame)}`;
    }
    case 'waiting':
      return firstLine(state.statusDetail ?? 'waiting for you', width);
    case 'error':
      return firstLine(state.statusDetail ?? 'failed', width);
    case 'done':
      return outcomeSummary(node, state.output) ?? plannedSummary(node);
    case 'skipped':
      return firstLine(state.statusDetail ?? 'skipped', width);
    default:
      return plannedSummary(node);
  }
}

/**
 * The metrics line: tokens consumed so far and wall-clock time, both live
 * while the node runs and frozen at its final value afterwards. Empty for a
 * node that hasn't started — there is nothing to measure yet.
 */
export function nodeMetrics(
  state: NodeRunState,
  now: number,
  /** Drop the clock and keep only the token counts — the compact card puts
   * this on the title row, where there is rarely room for both, and tokens
   * are the number a budget is spent in. */
  options: { clock?: boolean } = {},
): string {
  const parts: string[] = [];
  if (state.tokens) {
    parts.push(`↑${formatTokens(promptTokens(state.tokens))} ↓${formatTokens(state.tokens.output)}`);
  }
  if (options.clock !== false && state.startedAt) {
    const end = state.endedAt ? Date.parse(state.endedAt) : now;
    parts.push(formatDuration(end - Date.parse(state.startedAt)));
  }
  return parts.join(' · ');
}

/** Every token the run has consumed, for the header total. */
export function totalTokens(nodes: Record<string, NodeRunState>): number {
  return Object.values(nodes).reduce((sum, n) => sum + sumTokens(n.tokens), 0);
}
