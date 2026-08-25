/**
 * The reporting surface as MCP tools.
 *
 * The argument for this existing alongside `flow-code node …` is that a tool
 * in the model's tool list is reached for, and a command in an instructions
 * file is remembered — sometimes. Both matter: MCP gets the behaviour right
 * when the host supports it, and the CLI works on hosts that do not and needs
 * no registration anywhere.
 *
 * This module is deliberately a boundary and nothing else: it translates tool
 * calls into the same `guest/report.ts` functions the CLI calls, and translates
 * refusals into tool errors. No validation, no writing, and no notion of what
 * a legal transition is lives here — which is what lets the interesting half
 * be tested without standing up a server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listRunStates } from '../runstate/persist.js';
import type { RunState } from '../runstate/types.js';
import { WorkflowValidationError } from '../workflow/load.js';
import { rehydrateGraph } from '../workflow/record.js';
import { planOutput } from '../registry/index.js';
import { listPresets } from '../presets.js';
import { selectWorkflow } from '../workflow/select.js';
import { describePlanProposal } from '../workflow/splice.js';
import { enforcementLive } from './enforce.js';
import { generateInstructions, nodeBrief } from './instructions.js';
import {
  closeGuestRun,
  currentGuestRun,
  GuestReportError,
  acceptPlan,
  openGuestRun,
  proposePlan,
  reportTransition,
} from './report.js';
import type { ReportedTransition } from './validate.js';

/** What every tool here returns: text the model reads, and whether it went wrong. */
interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * A refusal, returned as a tool error rather than thrown.
 *
 * A thrown error becomes a protocol-level failure the model sees as "the tool
 * broke"; an `isError` result is a message it can read and act on. Every
 * refusal here is actionable by construction — it names a node, a status, or
 * an ordering problem — so all of them take this path.
 */
function refuse(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Turn a refusal into a tool error, and let anything unexpected through as a real fault. */
function guard(fn: () => string): ToolResult {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof GuestReportError) return refuse(err.message);
    throw err;
  }
}

/**
 * The run a tool call targets. An explicit id wins; otherwise the newest open
 * reported run, which is what a session working through one graph means.
 */
function resolveRun(repoRoot: string, run: string | undefined): RunState {
  const states = listRunStates(repoRoot);
  if (run !== undefined) {
    const found = states.find((s) => s.runId === run || s.runId.startsWith(run));
    if (!found) throw new GuestReportError(`no run \`${run}\` in this repository`);
    return found;
  }
  const current = currentGuestRun(repoRoot, states);
  if (!current) {
    throw new GuestReportError('no open run — call `open_run` before reporting a transition');
  }
  return current;
}

function describe(state: RunState): string {
  const order = state.graph?.nodes.map((n) => n.id) ?? Object.keys(state.nodes);
  const rows = order.map((id) => {
    const node = state.nodes[id];
    const detail = node?.statusDetail ? ` — ${node.statusDetail}` : '';
    return `  ${node?.status ?? 'unknown'}  ${id}${detail}`;
  });
  return `run ${state.runId}\n${rows.join('\n')}`;
}

/**
 * The load-bearing part of "a gate decision comes from a person".
 *
 * A tool annotated `requiresUserInteraction` always shows its full permission
 * prompt: it cannot be satisfied by a pre-approved allow rule, and in a
 * non-interactive mode it is refused rather than passed. That is what makes
 * the person's presence something the host cannot quietly supply on their
 * behalf. An elicitation dialog alone would not — a host-side auto-responder
 * can answer a dialog, which is precisely the hole this closes.
 *
 * Cast because the SDK's `ToolAnnotations` type is closed and predates the
 * field. Annotations are an open map on the wire, so this reaches the host
 * intact; the cast is the type system being behind, not a claim being
 * smuggled past it. If a host does not recognize the field it ignores it —
 * and the run is then relying on the tool description alone, which is why the
 * recorded surface is a fact about the decision rather than a formality.
 */
const GATE_ANNOTATIONS = {
  title: 'Approval gate',
  requiresUserInteraction: true,
  destructiveHint: false,
  readOnlyHint: false,
} as Record<string, unknown>;

const PLAN_ACCEPT_ANNOTATIONS = {
  title: 'Accept negotiated graph',
  requiresUserInteraction: true,
  destructiveHint: false,
  readOnlyHint: false,
} as Record<string, unknown>;

const runArg = {
  run: z
    .string()
    .optional()
    .describe('Run id. Omit to use the run this session opened most recently.'),
};

/** A node's brief, resolved against the graph the run recorded. */
function briefFor(repoRoot: string, run: string | undefined, nodeId: string): string | undefined {
  try {
    const state = resolveRun(repoRoot, run);
    if (!state.graph) return undefined;
    // What the steps above already reported, so a delegated step is handed the
    // work it is meant to act on rather than having to go and find it — which
    // its capability set may well forbid.
    const outputs = Object.fromEntries(
      Object.entries(state.nodes)
        .filter(([, node]) => node.output !== undefined)
        .map(([id, node]) => [id, node.output]),
    );
    return nodeBrief(rehydrateGraph(state.graph, { repoRoot }), nodeId, outputs);
  } catch {
    // A brief is an aid, never a precondition: failing to build one must not
    // turn a successful transition into an error.
    return undefined;
  }
}

function isInteractiveNode(repoRoot: string, run: string | undefined, nodeId: string): boolean {
  try {
    const state = resolveRun(repoRoot, run);
    if (!state.graph) return false;
    return (
      rehydrateGraph(state.graph, { repoRoot }).nodes.find((node) => node.id === nodeId)?.type
        .interactive === true
    );
  } catch {
    return false;
  }
}

/**
 * Build the server. Exported separately from {@link runMcpServer} so a test can
 * hold one without a transport attached.
 */
export function buildMcpServer(repoRoot: string): McpServer {
  const server = new McpServer({ name: 'flow-code', version: '1' });

  const transition = (kind: ReportedTransition['kind'], run: string | undefined, rest: Omit<ReportedTransition, 'kind'>) =>
    guard(() => {
      const target = resolveRun(repoRoot, run);
      const { accepted, order } = reportTransition(repoRoot, target.runId, { ...rest, kind });
      const detail = accepted.detail !== undefined ? ` — ${accepted.detail}` : '';
      const line = `${accepted.nodeId} → ${accepted.status}${detail}`;
      // The same list `flow-code node done` prints, for the same reason: the
      // nodes a proposal introduced are in no instructions this session has
      // read, so the result of the report is the only place they appear.
      if (order === undefined) return line;
      return (
        `${line}\n\nThe graph grew. The run now holds: ${order.join(' → ')}. ` +
        `Report against these — they replace whatever came after \`${accepted.nodeId}\` in your instructions.`
      );
    });

  server.registerTool(
    'list_presets',
    {
      title: 'List workflow presets',
      description: 'List the canonical workflow presets that can be selected for the next run.',
    },
    async () =>
      ok(
        listPresets()
          .map((preset) => `${preset.name}: ${preset.description}`)
          .join('\n'),
      ),
  );

  server.registerTool(
    'describe_workflow',
    {
      title: "Read this project's graph",
      description:
        'Return the steps the next run will go through, what each one must produce, and how to ' +
        'report progress. Call this before opening a run. By default it describes the project ' +
        'workflow. Pass a preset when the user names it; also use `planned` when they ask to ' +
        'create, design, or negotiate the graph for this task.',
      inputSchema: {
        graph: z
          .string()
          .optional()
          .describe('Which declared graph to describe, for a workflow file that declares several.'),
        preset: z
          .string()
          .optional()
          .describe(
            'Canonical preset to describe instead of the project workflow; graph-creation intent selects `planned`.',
          ),
      },
    },
    async ({ graph, preset }) => {
      // Generated on every call rather than installed anywhere. A host reading
      // its instructions through a tool cannot be holding stale ones: there is
      // no copy to go out of date with the workflow file.
      try {
        return ok(
          generateInstructions(
            (
              await selectWorkflow(repoRoot, {
                ...(graph !== undefined ? { graph } : {}),
                ...(preset !== undefined ? { preset } : {}),
              })
            ).workflow,
            {
              enforced: enforcementLive(repoRoot),
            },
          ),
        );
      } catch (err) {
        if (err instanceof WorkflowValidationError) {
          return refuse(
            `the selected workflow is invalid:\n${err.problems.map((p) => `  - ${p}`).join('\n')}`,
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'open_run',
    {
      title: 'Open a flow-code run',
      description:
        "Open a run against this project's workflow graph and return the node ids in order. " +
        'Call this once, before starting the first step, with the same preset passed to describe_workflow.',
      inputSchema: {
        graph: z
          .string()
          .optional()
          .describe('Which declared graph to run, for a workflow file that declares several.'),
        preset: z
          .string()
          .optional()
          .describe('Canonical preset to run for this session, instead of the project workflow.'),
      },
    },
    async ({ graph, preset }) => {
      try {
        const opened = await openGuestRun(repoRoot, {
          surface: 'mcp',
          ...(graph !== undefined ? { graph } : {}),
          ...(preset !== undefined ? { preset } : {}),
        });
        return ok(
          `opened run ${opened.runId}\nsteps: ${opened.order.join(' → ')}\n` +
            'Report each step started before you work on it, and complete when it finishes.',
        );
      } catch (err) {
        if (err instanceof GuestReportError) return refuse(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'start_node',
    {
      title: 'Report a step started',
      description:
        'Report that you are beginning work on a step. Rejected if the steps above it are not ' +
        'finished — read the reason and report those first.',
      inputSchema: { node: z.string().describe('Node id from the workflow graph.'), ...runArg },
    },
    async ({ node, run }) => {
      const result = transition('start', run, { nodeId: node });
      if (result.isError === true) return result;
      // The brief comes back with the transition rather than needing a second
      // call: an agent that has to remember to fetch it is an agent that
      // sometimes does not, and then runs the step from its own context.
      const brief = briefFor(repoRoot, run, node);
      return brief === undefined
        ? result
        : ok(
            `${result.content[0]!.text}\n\n--- brief for \`${node}\` ---\n${brief}\n\n` +
              (isInteractiveNode(repoRoot, run, node)
                ? 'This is an interactive step. Continue the discussion in the current user-facing conversation; do not delegate it to a fresh subagent.'
                : 'Run this step in a fresh subagent with the brief above, so it does not inherit this conversation\'s context. Report it complete when the subagent returns.'),
          );
    },
  );

  server.registerTool(
    'propose_plan',
    {
      title: 'Put a graph proposal on the table',
      description:
        'Validate and save a proposed Plan graph without adopting it. Show the returned graph to the user, revise it as needed, and call accept_plan only after the user explicitly agrees.',
      inputSchema: {
        node: z.string().describe('The Plan node id.'),
        proposal: planOutput.describe('The proposed nodes and edges. This is a draft until accept_plan is approved.'),
        ...runArg,
      },
    },
    async ({ node, proposal, run }) =>
      guard(() => {
        const saved = proposePlan(repoRoot, resolveRun(repoRoot, run).runId, node, proposal);
        return (
          `proposal saved for \`${saved.nodeId}\`. The graph has not changed.\n\n` +
          `${describePlanProposal(saved.proposal)}\n\n` +
          'Show this proposed graph to the user before asking whether to accept or revise it. Call `accept_plan` only after they explicitly agree.'
        );
      }),
  );

  server.registerTool(
    'accept_plan',
    {
      title: 'Accept the negotiated graph',
      description:
        'Adopt the pending Plan proposal only after the USER has explicitly agreed to it. This is the only tool that can complete a Plan node.',
      inputSchema: {
        node: z.string().describe('The Plan node id whose pending proposal the user accepted.'),
        ...runArg,
      },
      annotations: PLAN_ACCEPT_ANNOTATIONS,
    },
    async ({ node, run }) =>
      guard(() => {
        const target = resolveRun(repoRoot, run);
        const { accepted, order } = acceptPlan(repoRoot, target.runId, node);
        const line = `${accepted.nodeId} → ${accepted.status}`;
        return order === undefined
          ? line
          : `${line}\n\nThe graph grew. The run now holds: ${order.join(' → ')}. These nodes replace the old successors; report against them.`;
      }),
  );

  server.registerTool(
    'complete_node',
    {
      title: 'Report a step complete',
      description:
        "Report a step finished, with its output. The output is checked against the node type's " +
        'declared shape and rejected by field name if it does not match.',
      inputSchema: {
        node: z.string().describe('Node id from the workflow graph.'),
        // Declared as an object rather than `unknown`, which is what this was.
        // `unknown` advertises no type at all, and an agent given no type sends
        // a JSON *string* — a guess the CLI surface actively encourages, since
        // `flow-code node done --output <json>` takes JSON text and parses it.
        // The rejection that followed named the output shape, so the agent read
        // it as a content problem and retried the same encoding with different
        // content until it gave up. Every node type's output schema is an
        // object, so requiring one here excludes nothing and lets the host
        // reject the string before it ever reaches validation.
        output: z
          .record(z.string(), z.unknown())
          .describe(
            "The node's output as an object, matching its type's output shape. " +
              'Not a JSON string — send the object itself.',
          ),
        ...runArg,
      },
    },
    async ({ node, output, run }) => transition('done', run, { nodeId: node, output }),
  );

  server.registerTool(
    'fail_node',
    {
      title: 'Report a step failed',
      description:
        'Report that a step did not succeed, with the reason. If the graph declares a return ' +
        'path from this step, walk it yourself — nothing routes you back.',
      inputSchema: {
        node: z.string().describe('Node id from the workflow graph.'),
        reason: z.string().describe('Why it failed, recorded as the step\'s status detail.'),
        ...runArg,
      },
    },
    async ({ node, reason, run }) => transition('fail', run, { nodeId: node, reason }),
  );

  server.registerTool(
    'node_brief',
    {
      title: 'What a step is for',
      description:
        "Return one step's role prompt and output contract, phrased as a brief to hand to a " +
        'subagent. `start_node` already returns this; use it to re-read one.',
      inputSchema: { node: z.string().describe('Node id from the workflow graph.'), ...runArg },
    },
    async ({ node, run }) => {
      const brief = briefFor(repoRoot, run, node);
      return brief === undefined ? refuse(`no step \`${node}\` in this run`) : ok(brief);
    },
  );

  server.registerTool(
    'decide_gate',
    {
      title: 'Record the user\'s decision at an approval gate',
      description:
        'Record what the USER decided at an approval gate. Ask them first, in your own words, and ' +
        'call this only with the answer they actually gave. Do not call it to move the run along.',
      inputSchema: {
        node: z.string().describe('The approval-gate node id.'),
        decision: z.enum(['approved', 'rejected']).describe('What the user decided.'),
        ...runArg,
      },
      annotations: GATE_ANNOTATIONS,
    },
    async ({ node, decision, run }) =>
      transition('gate', run, { nodeId: node, decision, surface: 'permission-prompt' }),
  );

  server.registerTool(
    'close_run',
    {
      title: 'Close the run',
      description: 'Close the run when the graph is finished, or when you are stopping early.',
      inputSchema: {
        interrupted: z
          .boolean()
          .optional()
          .describe('True when stopping before the graph is finished.'),
        ...runArg,
      },
    },
    async ({ interrupted, run }) =>
      guard(() => {
        const target = resolveRun(repoRoot, run);
        const closed = closeGuestRun(repoRoot, target.runId, interrupted ?? false);
        return `closed run ${closed.runId.slice(0, 8)}`;
      }),
  );

  server.registerTool(
    'run_status',
    {
      title: 'Where the run is',
      description:
        'List every step in the run and its current status. Use this to re-orient after a ' +
        'rejected report, or when picking work back up.',
      inputSchema: { ...runArg },
    },
    async ({ run }) => guard(() => describe(resolveRun(repoRoot, run))),
  );

  return server;
}

/** Serve on stdio until the host disconnects. */
export async function runMcpServer(repoRoot: string): Promise<void> {
  const server = buildMcpServer(repoRoot);
  await server.connect(new StdioServerTransport());
}
