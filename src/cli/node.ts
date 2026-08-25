/**
 * `flow-code node …` — the host-agnostic reporting surface.
 *
 * Every agent CLI can run a shell command; not every one speaks MCP, and none
 * of them need registration to run this. So this is the surface that works
 * everywhere, and the MCP server (`src/guest/mcp.ts`) is the better-ergonomics
 * version of the same operations for hosts that do speak it. Both call the
 * same functions in `guest/report.ts`, which is what keeps them from drifting
 * into two different ideas of what a legal transition is.
 *
 * Refusals exit non-zero with the reason on stderr, because the consumer is an
 * agent reading command output: an exit code it can branch on and a sentence
 * it can act on are the whole interface.
 */

import { readFileSync } from 'node:fs';
import {
  closeGuestRun,
  currentGuestRun,
  GuestReportError,
  openGuestRun,
  reportTransition,
} from '../guest/report.js';
import type { ReportedTransition } from '../guest/validate.js';
import { listRunStates } from '../runstate/persist.js';
import type { RunState } from '../runstate/types.js';
import { fail, repoRootFromCwd } from './context.js';

const NODE_HELP = `flow-code node — report progress through the graph from an agent flow-code is not running

Usage:
  flow-code node open [--graph <name>] [--json]
                              Open a run against .flow-code/workflow.yaml and print its id.
                              Every later subcommand defaults to the newest open reported run,
                              so the id is only needed when several are open at once
  flow-code node start <id> [--run <runId>]
                              Report that node <id> has started
  flow-code node done <id> [--output <json>|--output-file <path>] [--run <runId>]
                              Report node <id> complete. Output is checked against the node
                              type's shape (\`flow-code node-types\` prints it); with neither
                              flag, JSON is read from stdin
  flow-code node fail <id> <reason…> [--run <runId>]
                              Report node <id> failed, with the reason as its status detail
  flow-code node approve <id> | reject <id> [--run <runId>]
                              Record what the *user* decided at an approval gate. Requires an
                              interactive terminal: a gate answered by a script is not an approval
  flow-code node close [--run <runId>] [--interrupted]
                              Close the run. --interrupted marks it as stopped rather than done
  flow-code node current      Print the run later subcommands would target, and where it is

Runs opened this way record the \`reported\` tier: flow-code validates every transition
against the graph, and enforces nothing about what the agent may actually do.`;

/** `--flag value`, or undefined when the flag is absent. Fails when it is present with nothing after it. */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('-')) fail(`${flag} requires a value.`);
  return next;
}

/** Positional arguments, in order, with flags and their values removed. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

const VALUE_FLAGS = ['--run', '--graph', '--output', '--output-file'];

/**
 * Which run a subcommand targets. An explicit `--run` wins; otherwise the
 * newest open reported run, which is what an agent working through one graph
 * in one session always means.
 *
 * Never falls back to an engine-driven run: those belong to the process
 * driving them, and silently targeting one is exactly the mistake ownership
 * exists to prevent.
 */
function resolveRun(repoRoot: string, args: string[]): RunState {
  const explicit = flagValue(args, '--run');
  if (explicit !== undefined) {
    const found = listRunStates(repoRoot).find((s) => s.runId === explicit || s.runId.startsWith(explicit));
    if (!found) fail(`no run \`${explicit}\` in this repository.`);
    return found;
  }
  const current = currentGuestRun(repoRoot, listRunStates(repoRoot));
  if (!current) {
    fail('no open reported run in this repository — start one with `flow-code node open`.');
  }
  return current;
}

/**
 * The output for a `done` report: an inline flag, a file, or stdin.
 *
 * Three ways in because the callers are different kinds of thing — an agent
 * writing a shell command inline, a skill that built a file, and a pipeline.
 * A parse failure is reported here rather than passed to the validator, which
 * would otherwise report malformed JSON as a schema mismatch.
 */
function readOutput(args: string[]): unknown {
  const inline = flagValue(args, '--output');
  const file = flagValue(args, '--output-file');
  let text: string;
  if (inline !== undefined) {
    text = inline;
  } else if (file !== undefined) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      fail(`cannot read ${file}`);
    }
  } else if (!process.stdin.isTTY) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    fail('report output with --output <json>, --output-file <path>, or on stdin.');
  }
  if (text.trim() === '') {
    fail('no output given — a node reports what it produced, even when that is `{}`.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    fail(`output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One line per node: where the run is, at a glance. */
function describeRun(state: RunState): string {
  const order = state.graph?.nodes.map((n) => n.id) ?? Object.keys(state.nodes);
  const rows = order.map((id) => {
    const node = state.nodes[id];
    const detail = node?.statusDetail ? ` — ${node.statusDetail}` : '';
    return `  ${node?.status ?? 'unknown'}\t${id}${detail}`;
  });
  return `run ${state.runId}\n${rows.join('\n')}`;
}

export async function cmdNode(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(NODE_HELP);
    return;
  }
  const repoRoot = await repoRootFromCwd();

  try {
    switch (sub) {
      case 'open':
        return await cmdOpen(repoRoot, rest);
      case 'start':
      case 'done':
      case 'fail':
        return cmdTransition(repoRoot, sub, rest);
      case 'approve':
      case 'reject':
        return cmdGate(repoRoot, sub === 'approve' ? 'approved' : 'rejected', rest);
      case 'close':
        return cmdClose(repoRoot, rest);
      case 'current':
        console.log(describeRun(resolveRun(repoRoot, rest)));
        return;
      default:
        fail(`unknown \`flow-code node\` subcommand \`${sub}\`\n\n${NODE_HELP}`);
    }
  } catch (err) {
    if (err instanceof GuestReportError) fail(err.message);
    throw err;
  }
}

async function cmdOpen(repoRoot: string, args: string[]): Promise<void> {
  const graph = flagValue(args, '--graph');
  const opened = await openGuestRun(repoRoot, {
    surface: 'cli',
    ...(graph !== undefined ? { graph } : {}),
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ runId: opened.runId, order: opened.order }));
    return;
  }
  console.log(
    `flow-code: opened run ${opened.runId}\n` +
      `  nodes: ${opened.order.join(' → ')}\n` +
      `  tier:  reported — transitions are validated, nothing is enforced\n` +
      `  watch: flow-code watch ${opened.runId.slice(0, 8)}`,
  );
}

function cmdTransition(repoRoot: string, kind: 'start' | 'done' | 'fail', args: string[]): void {
  const [nodeId, ...reasonWords] = positionals(args, VALUE_FLAGS);
  if (nodeId === undefined) fail(`\`flow-code node ${kind}\` needs a node id.`);
  const run = resolveRun(repoRoot, args);

  const reported: ReportedTransition = {
    nodeId,
    kind,
    ...(kind === 'done' ? { output: readOutput(args) } : {}),
    ...(kind === 'fail' ? { reason: reasonWords.join(' ') } : {}),
  };
  const { accepted, order } = reportTransition(repoRoot, run.runId, reported);
  const detail = accepted.detail !== undefined ? ` — ${accepted.detail}` : '';
  console.log(`flow-code: ${accepted.nodeId} → ${accepted.status}${detail}`);
  // Printed only when the graph grew, and printed in full rather than as a
  // diff: the agent has just been handed nodes that are in no instructions it
  // has read, and the run is the only thing that knows they exist.
  if (order !== undefined) {
    console.log(`  the run now holds: ${order.join(' → ')}`);
  }
}

/**
 * Answer an approval gate from the terminal.
 *
 * The MCP surface gets its guarantee from a permission prompt the host cannot
 * pre-approve. There is no equivalent here, so this leans on the nearest real
 * thing: an interactive terminal. Refusing when stdin is not a TTY is what
 * stops a gate being answered by a script, a CI job, or an agent piping input
 * — the cases where "the user approved it" would be false.
 *
 * It is a weaker guarantee than the MCP one and is recorded as a different
 * surface for exactly that reason: `terminal` and `permission-prompt` are not
 * the same evidence, and flattening them would hide which one a given approval
 * actually has behind it.
 */
function cmdGate(repoRoot: string, decision: 'approved' | 'rejected', args: string[]): void {
  const [nodeId] = positionals(args, VALUE_FLAGS);
  if (nodeId === undefined) fail('name the approval gate to answer.');
  if (!process.stdin.isTTY) {
    fail(
      'an approval gate is answered by a person at a terminal — this is not one. ' +
        'Run it yourself in an interactive shell, or use the `decide_gate` tool from a session that has it.',
    );
  }
  const run = resolveRun(repoRoot, args);
  const { accepted } = reportTransition(repoRoot, run.runId, {
    nodeId,
    kind: 'gate',
    decision,
    surface: 'terminal',
  });
  console.log(`flow-code: ${accepted.nodeId} → ${decision}`);
}

function cmdClose(repoRoot: string, args: string[]): void {
  const run = resolveRun(repoRoot, args);
  const closed = closeGuestRun(repoRoot, run.runId, args.includes('--interrupted'));
  const outstanding = Object.values(closed.nodes).filter(
    (n) => n.status !== 'done' && n.status !== 'skipped',
  ).length;
  console.log(
    `flow-code: closed run ${closed.runId.slice(0, 8)}` +
      (outstanding > 0 ? ` — ${outstanding} node(s) never completed` : ''),
  );
}
