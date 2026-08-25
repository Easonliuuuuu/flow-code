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
import { nodeTypeReferenceLines } from '../registry/index.js';
import { presetNamesForSelection } from '../workflow/select.js';

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
  // Before the generic interactive case: what a Plan node settles with the
  // user is a graph, and "report the conclusion you both reached" would send
  // an agent off reporting prose against a schema that takes nodes and edges.
  if (node.type.id === 'plan') {
    return (
      'Stay in the current user-facing conversation. Settle with the user what should be built, ' +
      'then propose the graph that carries it out by calling `propose_plan`, drawn only from the built-in node types. Show the returned proposed graph to the user before asking whether to accept or revise it. Revise it ' +
      'as needed, and call `accept_plan` only after the user explicitly accepts it.'
    );
  }
  if (node.type.interactive) {
    return 'Stay in the current user-facing conversation and talk to the user until the question is settled, then report the conclusion you both reached.';
  }
  return 'Do the work yourself, then report what you produced.';
}

/**
 * What completing this node does to the graph — emitted for the one node type
 * whose completion changes it.
 *
 * Without this the brief is quietly wrong at exactly the moment it matters
 * most: it lists the graph as it stands *before* planning, which is every node
 * except the ones the agent is about to be asked to walk. An agent reading only
 * the brief would plan a graph, report the Plan node complete, and then look
 * for its planned steps in a list that never had them.
 *
 * Nothing is emitted for a workflow with no Plan node, so a fixed graph's brief
 * is not padded with a step that cannot occur there.
 */
function expansionNote(node: WorkflowNode, next: readonly string[]): string[] {
  if (node.type.id !== 'plan') return [];
  const where =
    next.length > 0
      ? `between this step and ${next.map((id) => `\`${id}\``).join(', ')}`
      : 'after this step';
  return [
    `- **This step changes the graph:** your output *is* a proposed set of nodes and edges. ` +
      `Accepting the proposal splices it into the run ${where}, so the steps you planned ` +
      `become real nodes you can report against. From that point the run — not these instructions ` +
      `— is what says which nodes exist: the report hands back the ids the run now holds, and ` +
      `those are the ones to walk. A proposal that does not build a valid graph is refused and ` +
      `this step stays running, so read the reason and propose again.`,
  ];
}

/**
 * The skills a step is meant to be worked with, named so the agent can load
 * them itself.
 *
 * An engine-driven run composes a node's attached skills into the system
 * prompt ahead of its role prompt (`executors/helpers.ts`, `composeRolePrompt`).
 * Nothing does that here — flow-code did not start this session and cannot put
 * anything in its context. Left unsaid, the `skills:` a preset carries would
 * simply vanish: the openspec preset would arrive as the openspec *shape* run
 * on stock role prompts, with the method it exists to apply nowhere in sight.
 *
 * So they are named rather than inlined. A host session that resolved these
 * skills already has them on disk and its own mechanism for loading one, and
 * inlining four skill bodies into a brief would bury the step's own
 * instructions under them.
 */
function skillsNote(node: WorkflowNode): string[] {
  if (node.skills.length === 0) return [];
  const named = node.skills.map((s) => `\`${s.id}\``).join(', ');
  return [`- **Work it with:** ${named} — load the skill and follow it for this step.`];
}

function nodeSection(node: WorkflowNode, index: number, workflow: Workflow): string {
  const next = workflow.graph.directDependents(node.id);
  const lines = [
    `### ${index + 1}. \`${node.id}\` — ${node.type.displayName}`,
    '',
    purposeOf(node) + '.',
    '',
    `- **How:** ${howToWork(node)}`,
    ...skillsNote(node),
    `- **Report on completion:** \`${node.type.outputSummary}\``,
    `- **Then:** ${next.length > 0 ? next.map((id) => `\`${id}\``).join(', ') : 'nothing — this is the end of the graph'}`,
    ...expansionNote(node, next),
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
export interface InstructionOptions {
  /**
   * Whether flow-code's enforcement layer is in force for the session these
   * instructions are for. Changes what the closing section can honestly claim,
   * which is the one part of this document that must never be generic.
   */
  enforced?: boolean;
}

/**
 * Why a step's `model:` is never repeated back to the agent.
 *
 * It is not merely unenforceable here — it is unusable. The field names a
 * model from flow-code's own provider config, resolved when flow-code spawns
 * the session. Nothing on the other side of this boundary can resolve that
 * string, and a host that guessed at it would be overriding a model the user
 * already chose for their session. So the field is dropped, and this says so:
 * a silent drop reads as "my setting took effect" to whoever wrote it.
 */
const MODEL_NOTE = [
  '',
  'A step\'s `model:` is engine configuration and never reaches you: it names a model from',
  'flow-code\'s own provider config, which says nothing about what your session can run. Choose',
  'per step yourself — how each one is worked is described above.',
];

/**
 * The closing section, which is the only part that depends on anything beyond
 * the workflow file. An agent that is told nothing is enforced when calls are
 * in fact being denied will read a denial as a bug and work around it; one
 * told it is enforced when it is not will trust a boundary that is not there.
 */
function whatThisIsSection(enforced: boolean): string[] {
  if (!enforced) {
    return [
      '### What this does not do',
      '',
      'flow-code is not executing you. It validates the order of what you report and records it;',
      'it does not restrict which tools you use, choose your model, or count your tokens. The run',
      'is recorded at the `reported` tier and is labelled that way wherever it is displayed, so do',
      'not treat a green graph as evidence that anything was checked.',
      ...MODEL_NOTE,
    ];
  }
  return [
    '### What is enforced, and what is not',
    '',
    'While a step is in progress, your tool calls are checked against that step\'s capability set',
    'and denied if they fall outside it — a review step cannot edit files, and no step can write',
    'to the repository while an approval gate above it is unanswered. A denial is the boundary',
    'working, not a bug: do not try to route around it, and do not report a step complete that you',
    'were prevented from doing.',
    '',
    'What is *not* enforced, because flow-code did not start your session: which model you run on,',
    'what your session costs, the directory and environment you run in, which subagent types you',
    'delegate to, and routing you back along a return path. Those remain yours to get right. A',
    'subagent you spawn is still held to the step\'s capability set — its calls arrive here too.',
    ...MODEL_NOTE,
  ];
}

export function generateInstructions(workflow: Workflow, opts: InstructionOptions = {}): string {
  const order = workflow.order;
  const nodes = order
    .map((id, i) => nodeSection(workflow.nodes.find((n) => n.id === id)!, i, workflow))
    .join('\n\n');
  const loopbacks = loopbackSection(workflow);
  const hasPlan = workflow.nodes.some((node) => node.type.id === 'plan');
  const planningVocabulary = hasPlan
    ? [
        '## Planning vocabulary',
        '',
        'A Plan proposal may use only these built-in node types:',
        '',
        ...nodeTypeReferenceLines(),
      ]
    : [];

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
    'Choose the workflow source before calling `describe_workflow` or `open_run`. An explicit',
    `preset name (${presetNamesForSelection().join(', ')}) wins over inferred intent. If the user names two`,
    'presets, stop and ask which one they want. Otherwise route the request as follows:',
    '',
    '- **OpenSpec:** only when the user names OpenSpec.',
    '- **Spec Kit:** only when the user names Spec Kit, SpecKit, or `spec-kit`.',
    '- **Frugal:** when the user names the frugal preset. If they only ask to save tokens, time,',
    '  or cost, ask whether they want Frugal before opening a run.',
    '- **Planned:** when the user names the planned preset, or asks to create, design, or negotiate',
    '  the graph/workflow for this task, decide the execution steps together, or form the graph',
    '  before coding. Generic requests to "plan the implementation" do not select this preset.',
    '- **Project workflow:** when none of those triggers is present.',
    '',
    'Generic requests to write a spec do not select OpenSpec or Spec Kit. Once selected, pass the',
    'same `preset` to both calls; never open the project workflow first and switch afterwards. The',
    'preset is canonical and does not modify `.flow-code/workflow.yaml`; if its CLI or skills are',
    'missing, stop and show the setup command rather than falling back to another workflow.',
    '',
    '### How to report',
    '',
    '```',
    'flow-code node open --json          # once, at the start; prints the run id',
    'flow-code node start <id>           # before working on a step',
    'flow-code node done <id> --output \'{…}\'   # when it finishes, with its output',
    'flow-code node propose-plan <id> --output \'{…}\'  # save a Plan draft without adopting it',
    'flow-code node accept-plan <id>       # user accepts the pending Plan draft in a terminal',
    'flow-code node fail <id> <reason>   # when it does not',
    'flow-code node close                # once, at the end',
    '```',
    '',
    'When a preset is selected by name or by the routing rules above, use',
    '`describe_workflow({ preset: "<name>" })` and',
    '`open_run({ preset: "<name>" })` over MCP, or `flow-code node describe --preset <name>` and',
    '`flow-code node open --preset <name>` over the CLI.',
    '',
    'Every transition is checked against the graph: a step cannot start before the steps above it',
    'are done, and cannot complete without having started. A rejected report changes nothing and',
    'tells you why — read the reason and fix the sequence rather than reporting something else.',
    '',
    '### The steps',
    '',
    nodes,
    ...(planningVocabulary.length > 0 ? ['', ...planningVocabulary] : []),
    ...(loopbacks ? ['', loopbacks] : []),
    '',
    ...whatThisIsSection(opts.enforced === true),
  ].join('\n');
}

/**
 * One node's work, phrased as a brief to hand to a fresh agent.
 *
 * This is what makes a host session able to keep the graph's most valuable
 * property. Collapsing every step into one conversation puts Implement and
 * Review in the same context window, which makes the reviewer the author —
 * the specific failure the graph exists to prevent. An engine-driven run
 * avoids it by spawning a session per node; a host session avoids it by
 * delegating each node to a subagent, and a subagent needs the node's role
 * prompt and config, not a pointer to them.
 */
export function nodeBrief(
  workflow: Workflow,
  nodeId: string,
  /**
   * What the steps above this one reported, keyed by node id.
   *
   * Without this a delegated step arrives with nothing to work from. A Review
   * subagent is the case that proves it: its capability set is `read`, so it
   * cannot run `git diff`, and the diff it is supposed to review lives in
   * Implement's recorded output — which only the parent conversation had. The
   * engine never has this problem because it serializes upstream outputs into
   * every node's context (`executors/helpers.ts`, `upstreamPreamble`); this is
   * the same idea for a run the engine is not driving.
   */
  outputs: Readonly<Record<string, unknown>> = {},
): string | undefined {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  const config = node.config as Record<string, unknown> | undefined;
  const instructions = typeof config?.['instructions'] === 'string' ? config['instructions'] : undefined;
  const topic = typeof config?.['topic'] === 'string' ? config['topic'] : undefined;
  const commands = Array.isArray(config?.['commands']) ? (config['commands'] as unknown[]) : undefined;

  const upstream = workflow.graph
    .directDependencies(nodeId)
    .flatMap((id) => {
      const output = outputs[id];
      if (output === undefined) return [];
      const type = workflow.nodes.find((n) => n.id === id)?.type.id ?? 'unknown';
      return [`### Output of upstream step \`${id}\` (${type})\n${serializeOutput(output)}`];
    });

  return [
    `You are the \`${node.id}\` step (${node.type.displayName}) of this project's flow-code graph.`,
    '',
    node.type.rolePrompt.trim() || purposeOf(node) + '.',
    // Named ahead of the step's own instructions, mirroring the order
    // `composeRolePrompt` uses for an engine-driven run: a skill says *how* to
    // work, so it belongs before the specifics of what this step is doing.
    ...(node.skills.length > 0
      ? [
          '',
          `Work this step with the ${node.skills.map((s) => `\`${s.id}\``).join(', ')} skill` +
            `${node.skills.length === 1 ? '' : 's'}: load ${node.skills.length === 1 ? 'it' : 'them'} ` +
            'and follow the method described there. It governs how you work, not what you must ' +
            'produce — the output shape below still stands, and so does the capability boundary.',
        ]
      : []),
    ...(instructions ? ['', `This project's instructions for this step: ${instructions}`] : []),
    ...(topic ? ['', `Topic: ${topic}`] : []),
    ...(commands ? ['', `Commands to run: ${commands.map((c) => `\`${String(c)}\``).join(', ')}`] : []),
    ...(node.type.id === 'plan'
      ? ['', '## Planning vocabulary', '', ...nodeTypeReferenceLines()]
      : []),
    ...(upstream.length > 0 ? ['', '## Upstream context', '', upstream.join('\n\n')] : []),
    '',
    `When you finish, report: \`${node.type.outputSummary}\`.`,
    '',
    'Your tool calls are checked against this step\'s capability set while it is the step in',
    'progress. A denial is the boundary working — do not try to route around it.',
  ].join('\n');
}

/** Longest upstream output carried into a brief before it is cut. */
const MAX_OUTPUT_CHARS = 6000;

/**
 * One upstream output as text a brief can carry.
 *
 * Truncated rather than omitted when it is large: a diff that is too long to
 * paste whole is exactly the case where the reviewer most needs to see its
 * beginning, and the marker tells them the rest exists.
 */
function serializeOutput(output: unknown): string {
  const json = JSON.stringify(output, null, 2) ?? String(output);
  return json.length <= MAX_OUTPUT_CHARS
    ? json
    : `${json.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated — ${json.length - MAX_OUTPUT_CHARS} more characters]`;
}

/** The instructions as a Claude Code skill document. */
export function skillDocument(workflow: Workflow, opts: InstructionOptions = {}): string {
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
    generateInstructions(workflow, opts),
    '',
  ].join('\n');
}

/** The instructions wrapped in the delimiters that make them replaceable in a shared file. */
export function instructionsSection(workflow: Workflow, opts: InstructionOptions = {}): string {
  return `${SECTION_BEGIN}\n\n${generateInstructions(workflow, opts)}\n\n${SECTION_END}`;
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
export function instructionState(
  installed: string | undefined,
  workflow: Workflow,
  opts: InstructionOptions = {},
): InstructionState {
  if (installed === undefined) return 'absent';
  return installed.trim() === instructionsSection(workflow, opts).trim() ? 'current' : 'stale';
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
