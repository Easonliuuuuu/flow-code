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
import { loadWorkflow, WorkflowValidationError } from '../workflow/load.js';
import { generateInstructions } from './instructions.js';
import {
  closeGuestRun,
  currentGuestRun,
  GuestReportError,
  openGuestRun,
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

const runArg = {
  run: z
    .string()
    .optional()
    .describe('Run id. Omit to use the run this session opened most recently.'),
};

/**
 * Build the server. Exported separately from {@link runMcpServer} so a test can
 * hold one without a transport attached.
 */
export function buildMcpServer(repoRoot: string): McpServer {
  const server = new McpServer({ name: 'flow-code', version: '1' });

  const transition = (kind: ReportedTransition['kind'], run: string | undefined, rest: Omit<ReportedTransition, 'kind'>) =>
    guard(() => {
      const target = resolveRun(repoRoot, run);
      const accepted = reportTransition(repoRoot, target.runId, { ...rest, kind });
      const detail = accepted.detail !== undefined ? ` — ${accepted.detail}` : '';
      return `${accepted.nodeId} → ${accepted.status}${detail}`;
    });

  server.registerTool(
    'describe_workflow',
    {
      title: "Read this project's graph",
      description:
        'Return the steps this project expects a task to go through, what each one must produce, ' +
        'and how to report progress. Call this before opening a run — the graph is per-project ' +
        'and this is the only place it is described.',
      inputSchema: {
        graph: z
          .string()
          .optional()
          .describe('Which declared graph to describe, for a workflow file that declares several.'),
      },
    },
    async ({ graph }) => {
      // Generated on every call rather than installed anywhere. A host reading
      // its instructions through a tool cannot be holding stale ones: there is
      // no copy to go out of date with the workflow file.
      try {
        return ok(
          generateInstructions(loadWorkflow(repoRoot, graph !== undefined ? { graph } : {})),
        );
      } catch (err) {
        if (err instanceof WorkflowValidationError) {
          return refuse(
            `this project's workflow file is invalid:\n${err.problems.map((p) => `  - ${p}`).join('\n')}`,
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
        'Call this once, before starting the first step.',
      inputSchema: {
        graph: z
          .string()
          .optional()
          .describe('Which declared graph to run, for a workflow file that declares several.'),
      },
    },
    async ({ graph }) => {
      try {
        const opened = await openGuestRun(repoRoot, {
          surface: 'mcp',
          ...(graph !== undefined ? { graph } : {}),
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
    async ({ node, run }) => transition('start', run, { nodeId: node }),
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
        output: z
          .unknown()
          .describe("The node's output, matching its type's output shape."),
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
