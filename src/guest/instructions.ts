/**
 * Teaching a host agent the graph it is supposed to walk.
 *
 * An engine-driven run needs none of this: the engine knows the order, hands
 * each node its role prompt, and routes the result. A reported run has to put
 * all of that in front of an agent as instructions, and the instructions have
 * to describe *this project's* graph — a generic description of flow-code is
 * worth nothing to an agent that has to name real node ids.
 *
 * So everything here is derived from `.flow-code/workflow.yaml`. Nothing is
 * hand-maintained, which is what makes staleness detectable: regenerate, and
 * compare against what is installed.
 */

import type { Workflow, WorkflowNode } from '../workflow/load.js';

/**
 * Delimiters around the section this owns inside a file it shares with the
 * user's own content. Everything between them is ours to replace; everything
 * outside is theirs and is never touched.
 */
export const SECTION_BEGIN = '<!-- flow-code:begin — generated from .flow-code/workflow.yaml -->';
export const SECTION_END = '<!-- flow-code:end -->';

function purposeOf(node: WorkflowNode): string {
  // The type's description is written for `flow-code node-types`, which means
  // it is already phrased as "what this step is for" rather than as API prose.
  const [first] = node.type.description.split('. ');
  return first?.trim() ?? node.type.displayName;
}

/** How a node is expected to be worked, which differs by type more than by config. */
function howToWork(node: WorkflowNode): string {
  if (node.type.id === 'approval-gate') {
    return 'Stop and ask the user directly. Do not decide this one yourself, and do not report it done on their behalf.';
  }
  if (!node.type.agentDriven) {
    return 'Run the commands this node is configured with, and report what they actually returned.';
  }
  if (node.type.interactive) {
    return 'Talk to the user until the question is settled, then report the conclusion you both reached.';
  }
  return 'Do the work yourself, then report what you produced.';
}

function nodeSection(node: WorkflowNode, index: number, workflow: Workflow): string {
  const next = workflow.graph.directDependents(node.id);
  const lines = [
    `### ${index + 1}. \`${node.id}\` — ${node.type.displayName}`,
    '',
    purposeOf(node) + '.',
    '',
    `- **How:** ${howToWork(node)}`,
    `- **Report on completion:** \`${node.type.outputSummary}\``,
    `- **Then:** ${next.length > 0 ? next.map((id) => `\`${id}\``).join(', ') : 'nothing — this is the end of the graph'}`,
  ];
  return lines.join('\n');
}

/**
 * Loop-backs, spelled out as work the agent has to do.
 *
 * This is the one place where a reported run is not merely less enforced than
 * an engine-driven one but structurally different. The engine *routes* a
 * failure back to its target. Nothing routes it here — so if the instructions
 * describe the edge without saying who is expected to traverse it, the agent
 * reads a diagram and stops at the failure.
 */
function loopbackSection(workflow: Workflow): string {
  const loopbacks = workflow.graph.allLoopbacks();
  if (loopbacks.length === 0) return '';
  const rows = loopbacks.map(
    (l) =>
      `- When \`${l.from}\` fails, go back to \`${l.to}\` and work forward again ` +
      `(up to ${l.maxAttempts} attempt${l.maxAttempts === 1 ? '' : 's'} at \`${l.from}\`). ` +
      `Report \`${l.from}\` failed with the reason, then report \`${l.to}\` started.`,
  );
  return [
    '## When a step fails',
    '',
    'Nothing routes you back automatically. These return paths are yours to walk:',
    '',
    rows.join('\n'),
    '',
    'If you run out of attempts, report the failing node failed and stop. Do not skip ahead past it.',
  ].join('\n');
}

/**
 * The instructions themselves — the same body whether it is installed as a
 * skill, pasted into an agent instruction file, or printed to a terminal.
 */
export function generateInstructions(workflow: Workflow): string {
  const order = workflow.order;
  const nodes = order
    .map((id, i) => nodeSection(workflow.nodes.find((n) => n.id === id)!, i, workflow))
    .join('\n\n');
  const loopbacks = loopbackSection(workflow);

  return [
    '## Walking this project\'s flow-code graph',
    '',
    'This project describes its work as a graph of steps. When you are asked to do a task here,',
    'walk the graph in order and report each step as you go, so the run is visible to anyone',
    'watching it (`flow-code watch`) instead of being a wall of transcript.',
    '',
    'Reporting is not bookkeeping done afterwards — report a step started *before* you do it and',
    'complete *when* you finish it. A report that arrives after the fact describes a run nobody',
    'could have watched.',
    '',
    '### How to report',
    '',
    '```',
    'flow-code node open --json          # once, at the start; prints the run id',
    'flow-code node start <id>           # before working on a step',
    'flow-code node done <id> --output \'{…}\'   # when it finishes, with its output',
    'flow-code node fail <id> <reason>   # when it does not',
    'flow-code node close                # once, at the end',
    '```',
    '',
    'Every transition is checked against the graph: a step cannot start before the steps above it',
    'are done, and cannot complete without having started. A rejected report changes nothing and',
    'tells you why — read the reason and fix the sequence rather than reporting something else.',
    '',
    '### The steps',
    '',
    nodes,
    ...(loopbacks ? ['', loopbacks] : []),
    '',
    '### What this does not do',
    '',
    'flow-code is not executing you. It validates the order of what you report and records it;',
    'it does not restrict which tools you use, choose your model, or count your tokens. The run',
    'is recorded at the `reported` tier and is labelled that way wherever it is displayed, so do',
    'not treat a green graph as evidence that anything was checked.',
  ].join('\n');
}

/** The instructions as a Claude Code skill document. */
export function skillDocument(workflow: Workflow): string {
  const ids = workflow.order.slice(0, 4).join(', ');
  return [
    '---',
    'name: flow-code-workflow',
    `description: >-`,
    `  Walk this project's flow-code graph (${ids}${workflow.order.length > 4 ? ', …' : ''}) and report`,
    '  each step, so the run shows up in the flow-code viewer. Use whenever you start a coding',
    '  task in this repository.',
    '---',
    '',
    generateInstructions(workflow),
    '',
  ].join('\n');
}

/** The instructions wrapped in the delimiters that make them replaceable in a shared file. */
export function instructionsSection(workflow: Workflow): string {
  return `${SECTION_BEGIN}\n\n${generateInstructions(workflow)}\n\n${SECTION_END}`;
}

/** The body of an installed section, or undefined when the file has none. */
export function installedSection(text: string): string | undefined {
  const start = text.indexOf(SECTION_BEGIN);
  if (start < 0) return undefined;
  const end = text.indexOf(SECTION_END, start);
  if (end < 0) return undefined;
  return text.slice(start, end + SECTION_END.length);
}

/**
 * Put `section` into `existing`, replacing a previously installed one.
 *
 * Idempotent by construction: the same section spliced twice produces the same
 * text, so re-running an install after no workflow change leaves the file
 * byte-identical. A file with no section yet gets it appended, which is the
 * only place this adds anything the user did not already have.
 */
export function spliceSection(existing: string, section: string): string {
  const current = installedSection(existing);
  if (current !== undefined) return existing.replace(current, section);
  if (existing.trim() === '') return `${section}\n`;
  return `${existing.replace(/\n+$/, '')}\n\n${section}\n`;
}

export type InstructionState = 'current' | 'stale' | 'absent';

/**
 * Whether what is installed still describes the workflow.
 *
 * `absent` and `stale` are kept apart deliberately: never having installed
 * instructions is a setup step nobody took, while stale instructions are an
 * agent being told to walk a graph that has since changed — the second is the
 * one that produces confidently wrong runs.
 */
export function instructionState(installed: string | undefined, workflow: Workflow): InstructionState {
  if (installed === undefined) return 'absent';
  return installed.trim() === instructionsSection(workflow).trim() ? 'current' : 'stale';
}

/**
 * What changed between an installed set of instructions and the current
 * workflow, in the terms a user can act on: which steps appeared, which went
 * away, and whether the order moved.
 */
export function describeDrift(installed: string, workflow: Workflow): string[] {
  const installedIds = [...installed.matchAll(/^### \d+\. `([^`]+)`/gm)].map((m) => m[1]!);
  const currentIds = workflow.order;
  const added = currentIds.filter((id) => !installedIds.includes(id));
  const removed = installedIds.filter((id) => !currentIds.includes(id));
  const differences: string[] = [];
  if (added.length > 0) differences.push(`added: ${added.join(', ')}`);
  if (removed.length > 0) differences.push(`no longer in the workflow: ${removed.join(', ')}`);
  if (
    differences.length === 0 &&
    installedIds.join(',') !== currentIds.filter((id) => installedIds.includes(id)).join(',')
  ) {
    differences.push(`order changed: ${installedIds.join(' → ')} is now ${currentIds.join(' → ')}`);
  }
  if (differences.length === 0) differences.push('a step\'s configuration or output shape changed');
  return differences;
}
