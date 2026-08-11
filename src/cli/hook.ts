/**
 * `flow-code hook <event>` — the enforcement layer, as the host invokes it.
 *
 * A host agent runs this as a subprocess before each tool call, hands it the
 * call on stdin, and reads a decision from stdout. That is the whole contract,
 * and it is the only place in flow-code that knows the shape of somebody
 * else's hook protocol. Everything it decides comes from `guest/enforce.ts`,
 * which in turn defers to the same policy function the engine uses.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **It always prints a decision, and always exits 0.** A hook that crashes
 *    is, in most hosts, a hook that gets ignored — a non-zero exit is reported
 *    to the user and the tool call proceeds. So every path here, including the
 *    ones reached by a bug, ends in a printed JSON decision. Failing closed is
 *    not achievable by throwing.
 * 2. **It is silent on stdout apart from that decision.** stdout is the
 *    protocol channel.
 */

import { readFileSync } from 'node:fs';
import {
  enforceCall,
  isReportingTool,
  recordDenial,
  recordHeartbeat,
} from '../guest/enforce.js';
import { findProjectRoot } from './status.js';

/** The subset of a host's PreToolUse payload this needs. Everything else is ignored. */
interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  /** Present when the call came from a delegated subagent, on hosts that say so. */
  agent_id?: string;
  agent_type?: string;
}

/**
 * A host's PreToolUse response. `allow` is deliberately *not* emitted for the
 * ordinary permitted case — see {@link respondAllow}.
 */
function emit(decision: 'allow' | 'deny' | undefined, reason?: string): void {
  const output: Record<string, unknown> = { hookEventName: 'PreToolUse' };
  if (decision !== undefined) output['permissionDecision'] = decision;
  if (reason !== undefined) output['permissionDecisionReason'] = reason;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
}

/**
 * Permit the call — by saying nothing about it.
 *
 * Returning an explicit `allow` would bypass the user's own permission
 * settings, turning "flow-code permits this" into "flow-code approves this on
 * your behalf". flow-code's job is to *narrow* what a node may do, never to
 * widen it past what the user already agreed to, so a permitted call is handed
 * back undecided and the host's normal rules apply.
 */
function respondAllow(): void {
  emit(undefined);
}

function respondDeny(reason: string): void {
  emit('deny', reason);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function runPreToolUseHook(raw: string): void {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    // Unparseable payload. This is a host contract we do not control changing
    // under us, which is exactly the case the tier model says must cost the
    // enforcement *and* the claim of it — but it must not brick the session,
    // because at this point we cannot even tell whether a run is open.
    respondAllow();
    return;
  }

  const cwd = input.cwd ?? process.cwd();
  // Resolved by walking up for `.flow-code` rather than by asking git: the
  // hook runs on every tool call, and a subprocess per call to learn something
  // a directory lookup already answers is a cost the user's session pays.
  const repoRoot = findProjectRoot(cwd);
  if (repoRoot === undefined) {
    // Not a flow-code project at all: nothing here is being enforced.
    respondAllow();
    return;
  }

  // Recorded before the decision, and for every call including permitted ones:
  // this is the evidence a run uses to claim the `hooks` tier, and it has to
  // exist by the time `open_run` runs — which it does, because `open_run` is
  // itself a tool call that passes through here first.
  recordHeartbeat(repoRoot, input.session_id);

  const toolName = input.tool_name ?? '';
  if (toolName === '' || isReportingTool(toolName)) {
    respondAllow();
    return;
  }

  const outcome = enforceCall(repoRoot, {
    toolName,
    toolInput: input.tool_input ?? {},
    ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
    ...(input.tool_use_id !== undefined ? { toolUseId: input.tool_use_id } : {}),
  });

  switch (outcome.kind) {
    case 'not-in-force':
      respondAllow();
      return;
    case 'allow':
      respondAllow();
      return;
    case 'deny':
      recordDenial(repoRoot, outcome.runId, {
        nodeId: outcome.nodeId,
        tool: toolName,
        summary: summarize(toolName, input.tool_input ?? {}),
        ...(outcome.decision.missingCapability !== undefined
          ? { missingCapability: outcome.decision.missingCapability }
          : {}),
        ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
        ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
        ...(input.tool_use_id !== undefined ? { toolUseId: input.tool_use_id } : {}),
      });
      respondDeny(outcome.decision.message ?? 'flow-code: denied by this run\'s capability set.');
      return;
    case 'failed':
      // Distinct wording from a capability denial on purpose: "this node may
      // not do that" and "flow-code could not work out whether it may" are
      // different facts, and an agent that cannot tell them apart will try to
      // work around the wrong one.
      respondDeny(
        `flow-code could not determine whether this call is permitted, so it was denied: ${outcome.reason}`,
      );
      return;
  }
}

/** Mirrors the engine's activity summaries, so both kinds of run read alike. */
function summarize(toolName: string, input: Record<string, unknown>): string {
  if (typeof input['command'] === 'string') return input['command'];
  if (typeof input['file_path'] === 'string') return `${toolName} ${input['file_path']}`;
  if (typeof input['notebook_path'] === 'string') return `${toolName} ${input['notebook_path']}`;
  if (typeof input['path'] === 'string') return `${toolName} ${input['path']}`;
  if (typeof input['pattern'] === 'string') return `${toolName} ${input['pattern']}`;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

export function cmdHook(args: string[]): void {
  const [event] = args;
  try {
    if (event === 'pretooluse') {
      runPreToolUseHook(readStdin());
      return;
    }
    // An event this build does not implement must not block the session.
    respondAllow();
  } catch (err) {
    // The last line of defence. Anything that reaches here is a bug in
    // flow-code, and the run is claiming enforcement it just failed to apply —
    // so the call is denied, and the reason says which of the two it is.
    respondDeny(
      'flow-code: the enforcement layer failed while checking this call, so it was denied. ' +
        `This is a bug: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
