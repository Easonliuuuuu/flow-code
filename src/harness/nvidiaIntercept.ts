/**
 * Layer 3 for the NVIDIA-backed runner: per-call capability check, mirroring
 * intercept.ts's contract (same PermissionDecision/ActivityEntry shapes) but
 * keyed to this runner's own tool names — there is no SDK hook to wire into.
 */
import type { CapabilitySet } from '../capabilities.js';
import { outsideWorkingDir, type PermissionDecision } from './intercept.js';
import { classifyCommand } from './gitCommands.js';
import { EDIT_TOOL_NAMES, EXEC_TOOL_NAMES, READ_TOOL_NAMES } from './nvidiaTools.js';
import type { RunStateStore } from '../runstate/store.js';

interface InternalDecision extends PermissionDecision {
  missingCapability?: string;
}

export interface NvidiaInterceptorOptions {
  nodeId: string;
  instanceId?: string;
  capabilities: CapabilitySet;
  workingDir: string;
  store: RunStateStore;
}

export interface NvidiaInterceptor {
  /** Inspect a tool call before it executes; every call is logged from here. */
  check(toolName: string, input: Record<string, unknown>, toolUseId: string): PermissionDecision;
  /** Complete an allowed call's log entry once the tool finished. */
  complete(
    toolUseId: string,
    result: { durationMs?: number; exitStatus?: number | null; error?: string },
  ): void;
}

const READ_SET = new Set<string>(READ_TOOL_NAMES);
const EDIT_SET = new Set<string>(EDIT_TOOL_NAMES);
const EXEC_SET = new Set<string>(EXEC_TOOL_NAMES);

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (typeof input['command'] === 'string') return input['command'];
  if (typeof input['path'] === 'string') return `${toolName} ${input['path']}`;
  if (typeof input['pattern'] === 'string') return `${toolName} ${input['pattern']}`;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function pathArg(input: Record<string, unknown>): string | undefined {
  return typeof input['path'] === 'string' ? input['path'] : undefined;
}

export function createNvidiaInterceptor(opts: NvidiaInterceptorOptions): NvidiaInterceptor {
  const { nodeId, instanceId, capabilities: caps, workingDir, store } = opts;
  const startTimes = new Map<string, number>();
  const bashAvailable = caps.has('exec') || caps.has('git-read') || caps.has('git-write');

  function decide(toolName: string, input: Record<string, unknown>): InternalDecision {
    if (READ_SET.has(toolName) || EDIT_SET.has(toolName)) {
      const needed = EDIT_SET.has(toolName) ? 'edit' : 'read';
      if (!caps.has(needed)) {
        return {
          behavior: 'deny',
          missingCapability: needed,
          message: `flow-code: this node type does not have the \`${needed}\` capability.`,
        };
      }
      const target = pathArg(input);
      if (target !== undefined && outsideWorkingDir(workingDir, target)) {
        return {
          behavior: 'deny',
          missingCapability: 'working-directory',
          message: `flow-code: ${target} resolves outside this node's working directory (${workingDir}).`,
        };
      }
      return { behavior: 'allow' };
    }

    if (EXEC_SET.has(toolName)) {
      if (!bashAvailable) {
        return {
          behavior: 'deny',
          missingCapability: 'exec',
          message: 'flow-code: this node type cannot run shell commands.',
        };
      }
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      for (const segment of classifyCommand(command)) {
        if (segment.kind === 'git-write' && !caps.has('git-write')) {
          return {
            behavior: 'deny',
            missingCapability: 'git-write',
            message: `flow-code: \`${segment.text}\` is a git-mutating command and this node type does not have the \`git-write\` capability.`,
          };
        }
        if (segment.kind === 'git-read' && !caps.has('git-read') && !caps.has('exec')) {
          return {
            behavior: 'deny',
            missingCapability: 'git-read',
            message: `flow-code: \`${segment.text}\` requires the \`git-read\` capability.`,
          };
        }
        if (segment.kind === 'non-git' && !caps.has('exec')) {
          return {
            behavior: 'deny',
            missingCapability: 'exec',
            message: `flow-code: \`${segment.text}\` is not a git command, and this node type only has git access.`,
          };
        }
      }
      return { behavior: 'allow' };
    }

    return {
      behavior: 'deny',
      missingCapability: 'unknown-tool',
      message: `flow-code: tool ${toolName} is outside this node type's capability set.`,
    };
  }

  function record(
    toolName: string,
    input: Record<string, unknown>,
    decision: InternalDecision,
    toolUseId: string,
  ): void {
    store.appendActivity({
      ts: new Date().toISOString(),
      nodeId,
      ...(instanceId !== undefined ? { instanceId } : {}),
      tool: toolName,
      summary: summarize(toolName, input),
      decision: decision.behavior === 'allow' ? 'allowed' : 'denied',
      ...(decision.missingCapability !== undefined
        ? { missingCapability: decision.missingCapability }
        : {}),
      toolUseId,
    });
    if (decision.behavior === 'allow') startTimes.set(toolUseId, Date.now());
  }

  return {
    check(toolName, input, toolUseId) {
      const decision = decide(toolName, input);
      record(toolName, input, decision, toolUseId);
      return { behavior: decision.behavior, ...(decision.message ? { message: decision.message } : {}) };
    },
    complete(toolUseId, result) {
      const started = startTimes.get(toolUseId);
      startTimes.delete(toolUseId);
      const durationMs = result.durationMs ?? (started !== undefined ? Date.now() - started : 0);
      store.completeActivity(toolUseId, {
        durationMs,
        ...(result.exitStatus !== undefined ? { exitStatus: result.exitStatus } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    },
  };
}
