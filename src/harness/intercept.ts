import { isAbsolute, relative, resolve } from 'node:path';
import type { CapabilitySet } from '../capabilities.js';
import type { RunStateStore } from '../runstate/store.js';
import {
  ALWAYS_ALLOWED_TOOLS,
  ALWAYS_DENIED_TOOLS,
  EDIT_TOOLS,
  EXEC_TOOLS,
  READ_TOOLS,
} from './compile.js';
import { classifyCommand } from './gitCommands.js';

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

interface InternalDecision extends PermissionDecision {
  missingCapability?: string;
}

export interface InterceptorOptions {
  nodeId: string;
  instanceId?: string;
  capabilities: CapabilitySet;
  workingDir: string;
  store: RunStateStore;
}

export interface Interceptor {
  /**
   * Layer 3: inspect the actual tool input before execution. Every call —
   * allowed or denied — is appended to the activity log from here, which is
   * why the log costs nothing extra and exists without any UI.
   *
   * Wired to the SDK's PreToolUse hook, which fires for every tool call
   * (auto-allowed read tools never reach the permission prompt path).
   */
  check(
    toolName: string,
    input: Record<string, unknown>,
    opts?: { blockedPath?: string; toolUseID?: string },
  ): PermissionDecision;
  /**
   * Backstop for the SDK permission flow (canUseTool): applies the same
   * policy but only records *denials* — the PreToolUse hook already logged
   * the attempt as allowed (e.g. a Bash call later flagged with an
   * out-of-scope blockedPath).
   */
  promptCheck(
    toolName: string,
    input: Record<string, unknown>,
    opts?: { blockedPath?: string; toolUseID?: string },
  ): PermissionDecision;
  /** Complete an allowed call's log entry once the tool finished. */
  complete(
    toolUseId: string,
    result: { durationMs?: number; exitStatus?: number | null; error?: string },
  ): void;
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (typeof input['command'] === 'string') return input['command'];
  if (typeof input['file_path'] === 'string') return `${toolName} ${input['file_path']}`;
  if (typeof input['notebook_path'] === 'string') return `${toolName} ${input['notebook_path']}`;
  if (typeof input['path'] === 'string') return `${toolName} ${input['path']}`;
  if (typeof input['pattern'] === 'string') return `${toolName} ${input['pattern']}`;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

export function outsideWorkingDir(workingDir: string, candidate: string): boolean {
  const resolved = isAbsolute(candidate) ? candidate : resolve(workingDir, candidate);
  const rel = relative(resolve(workingDir), resolved);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

/** The control directory, named relative to whatever tree a node works in. */
const CONTROL_DIR = '.flow-code';

/**
 * True when a path lands inside the control directory of the node's own
 * working tree — the workflow file, credentials, specs and run-state.
 *
 * Deliberately computed *relative to the working directory* rather than
 * against an absolute repo root: a Worktree-Agent instance works inside
 * `<repo>/.flow-code/worktrees/<id>`, so an absolute containment test would
 * condemn everything it does, while the relative test correctly protects that
 * instance's own `.flow-code` and leaves the rest of its checkout writable.
 */
export function insideControlDir(workingDir: string, candidate: string): boolean {
  const resolved = isAbsolute(candidate) ? candidate : resolve(workingDir, candidate);
  const rel = relative(resolve(workingDir), resolved);
  return rel === CONTROL_DIR || rel.startsWith(`${CONTROL_DIR}/`);
}

/**
 * Shell commands that name a control artifact. Blunter than the path check —
 * a command string can reach a file in ways no argument parser will catch
 * (`sed -i`, redirection, `tee`) — so the artifacts that anchor the run are
 * named directly and any mention of them in a command is refused. Reading
 * them is still available through the Read tool.
 *
 * `.flow-code/runs` and `.flow-code/worktrees` are deliberately absent: those
 * are working data, and a worktree's own path legitimately appears in the
 * commands run inside it.
 */
export const CONTROL_ARTIFACT_IN_COMMAND = /\.flow-code[/\\](workflow\.ya?ml|credentials\.json|specs)/i;

export const CONTROL_DIR_DENIAL =
  'flow-code: the `.flow-code` control directory (workflow, credentials, specs) is not writable by a node — ' +
  'it is what defines and verifies this run, and a node that could edit it could grade its own homework.';

const READ_SET = new Set<string>(READ_TOOLS);
const EDIT_SET = new Set<string>(EDIT_TOOLS);
const EXEC_SET = new Set<string>(EXEC_TOOLS);
const DENIED_SET = new Set<string>(ALWAYS_DENIED_TOOLS);
const ALLOWED_SET = new Set<string>(ALWAYS_ALLOWED_TOOLS);

export function createInterceptor(opts: InterceptorOptions): Interceptor {
  const { nodeId, instanceId, capabilities: caps, workingDir, store } = opts;
  const startTimes = new Map<string, number>();
  const bashAvailable = caps.has('exec') || caps.has('git-read') || caps.has('git-write');

  function decide(
    toolName: string,
    input: Record<string, unknown>,
    callOpts?: { blockedPath?: string },
  ): InternalDecision {
    if (ALLOWED_SET.has(toolName)) return { behavior: 'allow' };

    if (DENIED_SET.has(toolName)) {
      return {
        behavior: 'deny',
        missingCapability: 'network',
        message: `flow-code: ${toolName} is unavailable — no node type has network or subagent access.`,
      };
    }

    if (READ_SET.has(toolName) || EDIT_SET.has(toolName)) {
      const needed = EDIT_SET.has(toolName) ? 'edit' : 'read';
      if (!caps.has(needed)) {
        return {
          behavior: 'deny',
          missingCapability: needed,
          message: `flow-code: this node type does not have the \`${needed}\` capability.`,
        };
      }
      const target =
        (typeof input['file_path'] === 'string' && input['file_path']) ||
        (typeof input['notebook_path'] === 'string' && input['notebook_path']) ||
        (typeof input['path'] === 'string' && input['path']) ||
        undefined;
      if (target !== undefined && outsideWorkingDir(workingDir, target)) {
        return {
          behavior: 'deny',
          missingCapability: 'working-directory',
          message: `flow-code: ${target} resolves outside this node's working directory (${workingDir}).`,
        };
      }
      // Reading the control directory is fine; writing to it is never.
      if (needed === 'edit' && target !== undefined && insideControlDir(workingDir, target)) {
        return {
          behavior: 'deny',
          missingCapability: 'control-directory',
          message: CONTROL_DIR_DENIAL,
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
      if (toolName !== 'Bash') return { behavior: 'allow' };

      if (
        callOpts?.blockedPath !== undefined &&
        outsideWorkingDir(workingDir, callOpts.blockedPath)
      ) {
        return {
          behavior: 'deny',
          missingCapability: 'working-directory',
          message: `flow-code: ${callOpts.blockedPath} is outside this node's working directory (${workingDir}).`,
        };
      }

      const command = typeof input['command'] === 'string' ? input['command'] : '';
      if (CONTROL_ARTIFACT_IN_COMMAND.test(command)) {
        return {
          behavior: 'deny',
          missingCapability: 'control-directory',
          message: CONTROL_DIR_DENIAL,
        };
      }
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
    toolUseId: string | undefined,
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
      ...(toolUseId !== undefined ? { toolUseId } : {}),
    });
    if (decision.behavior === 'allow' && toolUseId !== undefined) {
      startTimes.set(toolUseId, Date.now());
    }
  }

  return {
    check(toolName, input, callOpts) {
      const decision = decide(toolName, input, callOpts);
      record(toolName, input, decision, callOpts?.toolUseID);
      return { behavior: decision.behavior, ...(decision.message ? { message: decision.message } : {}) };
    },

    promptCheck(toolName, input, callOpts) {
      const decision = decide(toolName, input, callOpts);
      if (decision.behavior === 'deny') {
        record(toolName, input, decision, callOpts?.toolUseID);
      }
      return { behavior: decision.behavior, ...(decision.message ? { message: decision.message } : {}) };
    },

    complete(toolUseId, result) {
      const started = startTimes.get(toolUseId);
      startTimes.delete(toolUseId);
      const durationMs =
        result.durationMs ?? (started !== undefined ? Date.now() - started : 0);
      store.completeActivity(toolUseId, {
        durationMs,
        ...(result.exitStatus !== undefined ? { exitStatus: result.exitStatus } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    },
  };
}
