/**
 * Checking a transition somebody else claims happened.
 *
 * An engine-driven run cannot report a transition the graph forbids, because
 * the engine is the thing deciding what runs next — the ordering rules and the
 * execution are the same code. A reported run splits those apart: an external
 * agent says what it did, and nothing about saying it makes it true.
 *
 * So every reported transition is checked against the graph the run recorded
 * and the state that run is currently in, and a rejected report changes
 * nothing. This is the layer that keeps a self-reported graph from being
 * *worse* than no graph: a graph that quietly contradicts its own ordering
 * rules would be read as evidence that work happened in an order it did not.
 *
 * What it deliberately cannot check is whether the work was done at all. That
 * is reconciliation's job, against the tree.
 */

import { isRejectedGate } from '../runstate/types.js';
import type { GateDecision, NodeRunState, NodeStatus, RunState } from '../runstate/types.js';
import type { Workflow, WorkflowNode } from '../workflow/load.js';
import type { PlanProposal } from '../workflow/splice.js';

/** A transition an external agent claims to have made. */
export interface ReportedTransition {
  nodeId: string;
  kind: 'start' | 'done' | 'fail' | 'gate';
  /** Required by `done`: the node's output, checked against its type's shape. */
  output?: unknown;
  /** Required by `fail`: why it failed, recorded as the node's status detail. */
  reason?: string;
  /** Required by `gate`: what the person decided. */
  decision?: 'approved' | 'rejected';
  /** Required by `gate`: the surface that collected the decision from them. */
  surface?: string;
}

/** What run-state should become if the report is accepted. */
export interface AcceptedTransition {
  nodeId: string;
  status: NodeStatus;
  detail?: string;
  /** Present for `done`: the output as the node type's schema parsed it. */
  output?: unknown;
  /**
   * Nodes to return to `idle` alongside this transition — the segment a
   * loop-back re-runs. Empty for every ordinary transition.
   */
  reset?: string[];
  /** Present for `gate`: how the decision was reached, recorded on the node. */
  gateDecision?: GateDecision;
  /**
   * Present when completing this node grows the run's graph: the proposal to
   * splice, already parsed by the node type's own output schema.
   *
   * Carried on the transition rather than left for the writer to recognise in
   * `output`, so that "this report expands the graph" is decided once, here,
   * by the layer that already knows which node type it is looking at. A writer
   * that had to re-derive it would be a second place the answer could differ.
   */
  expandWith?: PlanProposal;
}

export type TransitionResult =
  | { ok: true; accepted: AcceptedTransition }
  | { ok: false; reason: string };

function reject(reason: string): TransitionResult {
  return { ok: false, reason };
}

/**
 * Whether an upstream node lets its dependents start.
 *
 * Mirrors the engine's own scheduling rule rather than restating it loosely: a
 * node skipped because a routing condition sent the run elsewhere did not
 * fail, so it does not hold up a node that also has a live path in. A node
 * skipped *because* something above it broke does.
 */
function upstreamSatisfied(node: NodeRunState | undefined): boolean {
  if (!node) return false;
  // A gate the user said no to never clears, whatever status it carries. The
  // guest path records a rejection as `error`, so this is belt-and-braces
  // today — but it is the check that actually holds the property, and it holds
  // it the same way `enforce.ts` blocks git writes: on the recorded decision,
  // not on a status whose meaning differs between the engine and this path.
  if (isRejectedGate(node)) return false;
  if (node.status === 'done') return true;
  return node.status === 'skipped' && node.skipReason === 'condition';
}

function nodeOf(workflow: Workflow, nodeId: string): WorkflowNode | undefined {
  return workflow.nodes.find((n) => n.id === nodeId);
}

/**
 * Check one reported transition against the run's recorded graph and its
 * current state, returning either what run-state should become or a reason a
 * reporting agent can act on.
 *
 * Pure: it reads state and returns a decision, and never writes. That is what
 * makes "a rejected report leaves the document unchanged" a property of the
 * shape of this module rather than a discipline every caller has to keep.
 */
export function validateTransition(
  workflow: Workflow,
  state: RunState,
  reported: ReportedTransition,
): TransitionResult {
  const node = nodeOf(workflow, reported.nodeId);
  if (!node) {
    // Listing the ids is the difference between an error an agent can recover
    // from and one it can only report back to a human.
    return reject(
      `unknown node \`${reported.nodeId}\` — this workflow defines: ${workflow.order.join(', ')}`,
    );
  }
  const current = state.nodes[reported.nodeId];
  if (!current) {
    return reject(`node \`${reported.nodeId}\` is in the workflow but not in this run's state`);
  }

  switch (reported.kind) {
    case 'start':
      return validateStart(workflow, state, node, current);
    case 'done':
      return validateDone(node, current, reported.output);
    case 'fail':
      return validateFail(node, current, reported.reason);
    case 'gate':
      return validateGate(node, current, reported.decision, reported.surface);
  }
}

/**
 * An Approval-Gate answered by a person.
 *
 * Kept off the ordinary completion path deliberately. `complete_node` is a
 * tool an agent calls whenever it decides a step is finished, and a gate whose
 * approval an agent can produce by deciding it is finished is not a gate. So
 * the only route to a decision is a surface that puts the question in front of
 * a human, and this refuses anything that arrives without one naming itself.
 */
function validateGate(
  node: WorkflowNode,
  current: NodeRunState,
  decision: 'approved' | 'rejected' | undefined,
  surface: string | undefined,
): TransitionResult {
  if (node.type.id !== 'approval-gate') {
    return reject(`node \`${node.id}\` is not an approval gate`);
  }
  if (current.status !== 'running' && current.status !== 'waiting') {
    return reject(`gate \`${node.id}\` cannot be answered from \`${current.status}\``);
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    return reject(`a gate decision must be \`approved\` or \`rejected\``);
  }
  if (surface === undefined || surface.trim() === '') {
    return reject(`a gate decision must record the surface that collected it`);
  }
  const at = new Date().toISOString();
  return {
    ok: true,
    accepted: {
      nodeId: node.id,
      // A rejected gate stops the run below it, which is what `error` means to
      // every downstream check — the same place an engine-driven rejection
      // leaves it.
      status: decision === 'approved' ? 'done' : 'error',
      ...(decision === 'rejected' ? { detail: 'rejected at the approval gate' } : {}),
      output: { decision, decidedAt: at },
      gateDecision: { decision, surface: surface.trim(), at },
    },
  };
}

function validateStart(
  workflow: Workflow,
  state: RunState,
  node: WorkflowNode,
  current: NodeRunState,
): TransitionResult {
  if (current.status === 'running') return reject(`node \`${node.id}\` is already running`);
  // A completed node is re-entered only by a loop-back — and under a reported
  // run the agent *is* the loop-back, because nothing routes it. Refusing this
  // would make the return path the generated instructions describe impossible
  // to walk, which is the one thing this surface must not do: the graph
  // declares the edge, so reporting a traversal of it has to be legal.
  if (current.status === 'done') return validateLoopbackReentry(workflow, state, node);
  // `error` is startable on purpose: retrying a node that failed on its own is
  // a further attempt at it. `idle` is the ordinary first attempt.
  const unsatisfied = workflow.graph
    .directDependencies(node.id)
    .filter((id) => !upstreamSatisfied(state.nodes[id]));
  if (unsatisfied.length > 0) {
    const which = unsatisfied
      .map((id) => `\`${id}\` (${state.nodes[id]?.status ?? 'unknown'})`)
      .join(', ');
    return reject(`node \`${node.id}\` cannot start while its upstream is unfinished: ${which}`);
  }
  return { ok: true, accepted: { nodeId: node.id, status: 'running' } };
}

/**
 * Re-entering a finished node, which is only legal as the target of a
 * loop-back whose source has actually failed.
 *
 * The engine routes this; here the agent walks it, so the check is the same
 * one the engine makes before it reroutes — is there a declared return path,
 * did the node it returns from fail, and has it any attempts left. Without the
 * attempt ceiling a reported run could loop for ever and record it as
 * progress, which is the failure `maxAttempts` exists to bound.
 */
function validateLoopbackReentry(
  workflow: Workflow,
  state: RunState,
  node: WorkflowNode,
): TransitionResult {
  const returning = workflow.graph
    .allLoopbacks()
    .filter((l) => l.to === node.id && state.nodes[l.from]?.status === 'error');
  if (returning.length === 0) {
    return reject(
      `node \`${node.id}\` is already done, and no failing step declares a return path to it`,
    );
  }
  const live = returning.find((l) => (state.nodes[l.from]?.attempt ?? 1) < l.maxAttempts);
  if (!live) {
    const spent = returning[0]!;
    return reject(
      `\`${spent.from}\` has used all ${spent.maxAttempts} of its attempts — ` +
        `report it failed and stop rather than looping again`,
    );
  }
  // Everything on the path between the target and the failing node runs again,
  // so it must go back to `idle` in the same write. Leaving them `done` would
  // show a run whose later steps are complete while an earlier one restarts.
  const reset = [...workflow.graph.nodesBetween(node.id, live.from)].filter((id) => id !== node.id);
  return { ok: true, accepted: { nodeId: node.id, status: 'running', reset } };
}

function validateDone(node: WorkflowNode, current: NodeRunState, output: unknown): TransitionResult {
  // An agent completing a gate is an agent approving its own work. The gate
  // surfaces exist precisely so that the decision cannot be produced by the
  // thing the decision is about.
  if (node.type.id === 'approval-gate') {
    return reject(
      `\`${node.id}\` is an approval gate — it is answered by the person, not reported complete. ` +
        'Ask them, and record their answer with the gate decision tool (`flow-code node approve` on the CLI).',
    );
  }
  if (current.status !== 'running' && current.status !== 'waiting') {
    return reject(
      `node \`${node.id}\` cannot complete from \`${current.status}\` — report it started first`,
    );
  }
  // A double-encoded output is a different mistake from a wrong one, and
  // naming it as a shape problem sends the reporter off editing content that
  // was never the issue. Checked before the schema so the message can say the
  // one thing that fixes it.
  if (typeof output === 'string') {
    return reject(
      `output for \`${node.id}\` arrived as a string. Send the object itself, not JSON text — ` +
        'the CLI takes `--output <json>` and parses it for you, but every other surface takes the ' +
        'object.',
    );
  }
  const parsed = node.type.outputSchema.safeParse(output);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return reject(`output does not match the ${node.type.id} output shape — ${problems}`);
  }

  // A node type owns the question of whether its own output means success.
  // Applying it here is what keeps a reported run's verdicts meaning the same
  // thing an engine-driven run's do: a Review that reports `verdict: reject`
  // lands in `error` whichever surface reported it.
  const failed = node.type.failsWhen?.(parsed.data) === true;
  if (!failed) {
    return {
      ok: true,
      accepted: {
        nodeId: node.id,
        status: 'done',
        output: parsed.data,
        // A Plan node's output *is* a proposed graph — the schema it just
        // passed is the workflow file's own `nodes`/`edges` — so completing
        // one is the transition that grows the run. Keyed on the type the
        // same way the engine keys on it (`freshlyCompletedPlanNode`), so
        // both paths expand for exactly the same set of nodes.
        ...(node.type.id === 'plan' ? { expandWith: parsed.data as PlanProposal } : {}),
      },
    };
  }
  const verdict = (parsed.data as { verdict?: unknown }).verdict;
  const detail =
    typeof verdict === 'string'
      ? `${node.type.displayName} verdict: ${verdict}`
      : `${node.type.displayName} reported failure`;
  return { ok: true, accepted: { nodeId: node.id, status: 'error', detail, output: parsed.data } };
}

function validateFail(
  node: WorkflowNode,
  current: NodeRunState,
  reason: string | undefined,
): TransitionResult {
  if (current.status !== 'running' && current.status !== 'waiting') {
    return reject(
      `node \`${node.id}\` cannot fail from \`${current.status}\` — report it started first`,
    );
  }
  if (reason === undefined || reason.trim() === '') {
    return reject(`report a reason with the failure of \`${node.id}\``);
  }
  return { ok: true, accepted: { nodeId: node.id, status: 'error', detail: reason.trim() } };
}
