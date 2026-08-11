/**
 * Applying a node's capability envelope inside a session flow-code did not
 * start.
 *
 * The engine gets to enforce by construction: it spawns the session, so it
 * knows which node is running and can hand the runner a compiled policy. Here
 * neither is true. A hook fires with a tool name and its input, and everything
 * else — which run, which node, what that node may do — has to be recovered
 * from the run document on disk, on every single call.
 *
 * That difference is the whole of this module. The *decision* is not made
 * here: it is made by `harness/intercept.ts`'s `decideCall`, the same function
 * the engine's interceptor calls. What is made here is the context that
 * decision needs, and the answer to what to do when that context cannot be
 * established.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilitySet, type Capability } from '../capabilities.js';
import { classifyCommand } from '../harness/gitCommands.js';
import { decideCall, type CallDecision } from '../harness/intercept.js';
import { listRunStates, readRunState, runFilePath } from '../runstate/persist.js';
import type { ActivityEntry, RunState } from '../runstate/types.js';
import type { Workflow, WorkflowNode } from '../workflow/load.js';
import { rehydrateGraph } from '../workflow/record.js';

/**
 * Where the hook records that it ran.
 *
 * This is how a run can claim the `hooks` tier honestly. An installed plugin
 * proves nothing — hooks can be disabled after installation, and a settings
 * file is a statement of intent rather than of fact. A file the hook itself
 * wrote, moments ago, is evidence that the hook is actually firing in this
 * session.
 *
 * It works because the reporting tools are themselves tool calls: the hook
 * fires for `open_run` *before* `open_run` executes, so by the time a run is
 * being opened a fresh heartbeat already exists.
 */
export const HEARTBEAT_FILE = join('.flow-code', 'enforcement.json');

/**
 * How recently the hook must have fired for enforcement to count as live.
 *
 * Generous on purpose. The cost of being too short is a run that under-claims
 * its tier — which is the safe direction and merely pessimistic. The cost of
 * being too long is a run claiming enforcement that stopped some time ago,
 * which is the direction that lies.
 */
export const HEARTBEAT_TTL_MS = 5 * 60 * 1000;

export interface Heartbeat {
  at: string;
  pid: number;
  /** The session the hook was firing in, when the host tells us. */
  sessionId?: string;
}

export function recordHeartbeat(repoRoot: string, sessionId?: string): void {
  const beat: Heartbeat = {
    at: new Date().toISOString(),
    pid: process.pid,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  try {
    writeFileSync(join(repoRoot, HEARTBEAT_FILE), JSON.stringify(beat));
  } catch {
    // Unwritable control directory. Enforcement still applies to this call —
    // the decision below does not depend on the heartbeat — it just means no
    // run will *claim* it, which is the honest failure.
  }
}

/**
 * Whether flow-code's enforcement layer is demonstrably running right now.
 *
 * Known limitation, recorded rather than hidden: the heartbeat is per
 * repository, not per session. Two concurrent sessions in one checkout, one
 * with the plugin installed and one without, would let the second open a run
 * claiming the `hooks` tier on the strength of the first one's heartbeat. The
 * tier is an honesty mechanism against accident, not a boundary against an
 * adversary — the design says as much about enforcement generally — and
 * narrowing this needs a session id the MCP server is not given.
 */
export function enforcementLive(repoRoot: string, now = Date.now()): boolean {
  try {
    const beat = JSON.parse(readFileSync(join(repoRoot, HEARTBEAT_FILE), 'utf8')) as Heartbeat;
    const at = Date.parse(beat.at);
    return Number.isFinite(at) && now - at < HEARTBEAT_TTL_MS && now - at > -HEARTBEAT_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * flow-code's own reporting tools, which enforcement must never block.
 *
 * A denied `start_node` would be a deadlock rather than a restriction: the
 * envelope is defined by the current node, and the only way to have a current
 * node is to report one started. An enforcement layer that can stop the run
 * from advancing is one that eventually has to be turned off.
 */
export function isReportingTool(toolName: string): boolean {
  return toolName.startsWith('mcp__flow-code__');
}

/**
 * What the hook concluded, in a shape a host's hook contract can be built
 * from without this module knowing anything about that contract.
 *
 * `notInForce` is the case that keeps the plugin usable: no flow-code run is
 * open, so there is no envelope, and an ordinary session goes on working
 * exactly as it did before the plugin was installed.
 */
export type EnforcementOutcome =
  | { kind: 'not-in-force'; reason: string }
  | { kind: 'allow'; runId: string; nodeId: string }
  | { kind: 'deny'; runId: string; nodeId: string; decision: CallDecision }
  /** Could not establish the envelope. Denied, and reported as a failure rather than a denial. */
  | { kind: 'failed'; reason: string; runId?: string };

/** The capability set a node's work runs under. */
export function capabilitiesForNode(node: WorkflowNode): ReturnType<typeof capabilitySet> {
  return capabilitySet(...(node.type.capabilities as Capability[]));
}

/**
 * The run enforcement applies to: the newest open run that flow-code's own
 * engine is not driving.
 *
 * An engine-driven run is deliberately skipped. That session already has the
 * real harness compiled into it, and a host session in the same repository is
 * doing something else entirely — applying that run's current node to it would
 * be enforcing one piece of work's envelope on another.
 */
export function runUnderEnforcement(repoRoot: string): RunState | undefined {
  return listRunStates(repoRoot)
    .filter((s) => s.finishedAt === undefined && s.enforcement?.tier !== 'engine')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * The node whose envelope is in force: the one the agent reported it is
 * working on.
 *
 * `waiting` counts alongside `running` — a node blocked on the user has not
 * handed its envelope back. More than one running at once should not happen in
 * a session that is one conversation, but if it does, graph order decides,
 * so the answer is at least stable between calls.
 */
export function currentNodeId(workflow: Workflow, state: RunState): string | undefined {
  return workflow.order.find((id) => {
    const status = state.nodes[id]?.status;
    return status === 'running' || status === 'waiting';
  });
}

/**
 * An Approval-Gate above `nodeId` that has not been approved, if there is one.
 *
 * Ordering validation already stops a node starting while an upstream gate is
 * unanswered, so in a well-behaved run this never fires. It is here as the
 * second layer the spec asks for: the ordering check guards the *transition*,
 * and this guards the *call*, so a run whose document was edited by hand, or
 * whose gate was reset after a downstream node started, still cannot commit.
 */
export function blockingGate(workflow: Workflow, state: RunState, nodeId: string): string | undefined {
  for (const id of workflow.graph.ancestorsOf(nodeId)) {
    const node = workflow.nodes.find((n) => n.id === id);
    if (node?.type.id !== 'approval-gate') continue;
    const recorded = state.nodes[id];
    const decision = (recorded?.output as { decision?: unknown } | undefined)?.decision;
    if (recorded?.status !== 'done' || decision !== 'approved') return id;
  }
  return undefined;
}

export interface EnforceInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Set when the call came from a delegated subagent rather than the session itself. */
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

/**
 * Decide one tool call against the run's current node.
 *
 * Every failure path below denies. That is the one place this design accepts a
 * usability cost outright: an enforcement layer whose failure mode is silent
 * permissiveness is worse than no enforcement at all, because the run would go
 * on recording a tier that claims a guarantee nobody delivered.
 */
export function enforceCall(repoRoot: string, input: EnforceInput): EnforcementOutcome {
  // Never block the run from advancing — see isReportingTool.
  if (isReportingTool(input.toolName)) {
    return { kind: 'not-in-force', reason: 'flow-code reporting tool' };
  }

  let state: RunState | undefined;
  try {
    state = runUnderEnforcement(repoRoot);
  } catch (err) {
    return { kind: 'failed', reason: `could not read this repository's runs: ${message(err)}` };
  }
  // No open run: nothing is being enforced, and an ordinary session must work
  // exactly as it did before the plugin was installed.
  if (!state) return { kind: 'not-in-force', reason: 'no open flow-code run' };

  let workflow: Workflow;
  try {
    if (!state.graph) throw new Error('the run recorded no graph');
    workflow = rehydrateGraph(state.graph, { repoRoot });
  } catch (err) {
    return {
      kind: 'failed',
      runId: state.runId,
      reason: `could not rebuild the graph run ${state.runId.slice(0, 8)} recorded: ${message(err)}`,
    };
  }

  const nodeId = currentNodeId(workflow, state);
  if (nodeId === undefined) {
    return {
      kind: 'failed',
      runId: state.runId,
      reason:
        'no step of this run is in progress, so there is no capability envelope to work inside. ' +
        'Report the step you are about to work on as started first.',
    };
  }
  const node = workflow.nodes.find((n) => n.id === nodeId)!;

  const gate = blockingGate(workflow, state, nodeId);
  const capabilities = capabilitiesForNode(node);
  const decision = decideCall({ capabilities, workingDir: repoRoot }, input.toolName, input.toolInput);

  // A gate above this node that nobody has approved withdraws exactly one
  // thing: the ability to mutate the repository. Applied by classifying the
  // command rather than by re-deciding without `git-write`, which would also
  // strip read-only git from a node whose only git capability is the write one
  // — `git status` is not what a gate is protecting anyone from.
  //
  // Runs after the capability decision, so a call already denied for a better
  // reason keeps that reason.
  if (decision.behavior === 'allow' && gate !== undefined && mutatesRepository(input)) {
    return {
      kind: 'deny',
      runId: state.runId,
      nodeId,
      decision: {
        behavior: 'deny',
        missingCapability: 'approval-gate',
        message:
          `flow-code: the \`${gate}\` approval gate has not been approved, so this run cannot ` +
          'write to the repository yet.',
      },
    };
  }

  if (decision.behavior === 'deny') {
    return { kind: 'deny', runId: state.runId, nodeId, decision };
  }
  return { kind: 'allow', runId: state.runId, nodeId };
}

/**
 * Whether a call writes to the repository, using the engine's own command
 * classification rather than a second opinion about what "a git write" means.
 */
function mutatesRepository(input: EnforceInput): boolean {
  if (input.toolName !== 'Bash') return false;
  const command = typeof input.toolInput['command'] === 'string' ? input.toolInput['command'] : '';
  return classifyCommand(command).some((segment) => segment.kind === 'git-write');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Append a denial to the run's activity log.
 *
 * The same shape an engine-driven denial takes, deliberately: the viewer's
 * activity rows, the denial counter on a node card, and the status line's
 * blocked-action indicator all read this, and none of them should need to know
 * which kind of run produced the entry.
 *
 * **Denials only, and that is a real difference from an engine-driven run.**
 * The engine logs every call because it holds the document in memory and pays
 * one write; a hook holds nothing between invocations, so logging allowed
 * calls would mean re-reading and rewriting the whole run document — an
 * ever-growing one — on every tool call the session makes. That cost lands on
 * the user's own session, and buys a history that the tier already declares it
 * does not have. A `hooks` run therefore records what it *blocked*, which is
 * the part that changes what the run means.
 *
 * Best-effort. A failure to record must not become a failure to enforce — the
 * decision has already been made by the time this runs, and losing a log line
 * is a smaller harm than turning a denial into an error the host may not treat
 * as blocking.
 */
export function recordDenial(
  repoRoot: string,
  runId: string,
  entry: Omit<ActivityEntry, 'ts' | 'decision'>,
): void {
  const path = runFilePath(repoRoot, runId);
  if (!existsSync(path)) return;
  try {
    const state = readRunState(path);
    const node = state.nodes[entry.nodeId];
    if (!node) return;
    const next: RunState = {
      ...state,
      activity: [...state.activity, { ts: new Date().toISOString(), decision: 'denied', ...entry }],
      nodes: { ...state.nodes, [entry.nodeId]: { ...node, denials: node.denials + 1 } },
    };
    // Written through the same atomic replacement every other writer uses, so
    // a hook that dies mid-write cannot leave a torn document.
    const tmp = `${path}.hook.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
  } catch {
    // See above: recording is best-effort, enforcing is not.
  }
}
