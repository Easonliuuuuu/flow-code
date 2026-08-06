import type { Capability, CapabilitySet } from '../capabilities.js';

export const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const EDIT_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
export const EXEC_TOOLS = ['Bash', 'BashOutput', 'KillShell'] as const;
/** No built-in node type grants network access in v1. */
export const NETWORK_TOOLS = ['WebFetch', 'WebSearch'] as const;
export const ALWAYS_DENIED_TOOLS = [...NETWORK_TOOLS] as const;
/**
 * The tool a session uses to spawn a subagent. Two names because the live SDK
 * sends `Agent` while `Task` is the older name — it has moved once, so both
 * stay recognized rather than trusting whichever is current.
 */
export const SPAWN_TOOLS = ['Agent', 'Task'] as const;
/** Harmless bookkeeping the SDK may use regardless of capabilities. */
export const ALWAYS_ALLOWED_TOOLS = ['TodoWrite'] as const;

export interface CompiledToolPolicy {
  disallowedTools: string[];
  /** Layer 1: states the boundary in the system prompt. Guarantees nothing. */
  boundaryPrompt: string;
  /** Env for the child process; includes the pushurl block when applicable. */
  env: Record<string, string>;
}

function bashAvailable(caps: CapabilitySet): boolean {
  return caps.has('exec') || caps.has('git-read') || caps.has('git-write');
}

/**
 * Layer 2: compile a capability set into the SDK's coarse tool deny list.
 * Layer 3 (the per-call interception check) lives in intercept.ts.
 */
export function compileToolPolicy(caps: CapabilitySet, workingDir: string): CompiledToolPolicy {
  const disallowed = new Set<string>(ALWAYS_DENIED_TOOLS);
  if (!caps.has('read')) for (const t of READ_TOOLS) disallowed.add(t);
  if (!caps.has('edit')) for (const t of EDIT_TOOLS) disallowed.add(t);
  if (!bashAvailable(caps)) for (const t of EXEC_TOOLS) disallowed.add(t);

  const lines: string[] = [
    'Capability boundary (enforced structurally, outside this prompt):',
    `- You may only operate inside ${workingDir}. File access outside it is denied.`,
    '- Network tools are unavailable.',
  ];
  if (!caps.has('edit')) lines.push('- You cannot create, edit, or delete files.');
  if (caps.has('exec')) {
    lines.push('- You may run shell commands, but git commands that mutate history, refs, or remotes are denied.');
  } else if (caps.has('git-write')) {
    lines.push('- Shell access is limited to git commands only.');
  } else if (caps.has('git-read')) {
    lines.push('- Shell access is limited to read-only git commands.');
  } else {
    lines.push('- You cannot run shell commands.');
  }
  if (!caps.has('git-write')) {
    lines.push('- Git operations that write (push, commit, merge, reset, …) are denied and will fail.');
  }
  lines.push('Denied calls return a tool error; note the denial and continue within your role.');

  const env: Record<string, string> = {};
  if (!caps.has('git-write')) {
    // Defense in depth: scoped to the child process only, never the repo config.
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'remote.origin.pushurl';
    env['GIT_CONFIG_VALUE_0'] = 'https://push-disabled-by-flow-code.invalid';
  }

  return {
    disallowedTools: [...disallowed],
    boundaryPrompt: lines.join('\n'),
    env,
  };
}

export function capabilityList(caps: CapabilitySet): Capability[] {
  return [...caps];
}

/**
 * A subagent definition, in runner-agnostic shape. Structurally compatible
 * with the Claude SDK's `AgentDefinition`; kept local so `compile.ts` stays
 * the shared harness rather than acquiring a dependency on one runner.
 */
export interface CompiledSubagent {
  description: string;
  prompt: string;
  /** At or below the parent node's tools — never above. */
  tools: string[];
  /**
   * Set explicitly because a subagent does *not* inherit the parent session's
   * permission mode. Left unset, its tool calls are refused before its hooks
   * run, which makes every subagent useless in a way nothing in the SDK's
   * types hints at.
   */
  permissionMode: 'default';
}

/** The tools a capability set actually permits — what a subagent may be given. */
function allowedTools(caps: CapabilitySet): string[] {
  const tools: string[] = [...ALWAYS_ALLOWED_TOOLS];
  if (caps.has('read')) tools.push(...READ_TOOLS);
  if (caps.has('edit')) tools.push(...EDIT_TOOLS);
  if (bashAvailable(caps)) tools.push(...EXEC_TOOLS);
  return tools;
}

/**
 * The subagent types a node may spawn. Closed by construction: a type absent
 * here is refused by the interception check, so the model cannot reach a
 * built-in agent type flow-code never offered.
 *
 * A subagent is given the parent node's tools and nothing more. It cannot
 * exceed them in any case — the interceptor checks its calls against the same
 * capability set — but handing it a narrower list first means it is not
 * offered a tool that would only ever be denied.
 *
 * Deliberately one general type rather than a taxonomy: nothing yet shows a
 * split earns its keep, and every entry here is a policy that has to be kept
 * true as capabilities change.
 */
export function compileSubagents(
  caps: CapabilitySet,
  opts: { enabled: boolean },
): Record<string, CompiledSubagent> {
  if (!opts.enabled) return {};
  return {
    worker: {
      description:
        'Delegate a self-contained piece of this task — a broad search, or one of ' +
        'several independent sub-tasks — and get back a summary.',
      prompt:
        'You are a worker delegated a self-contained piece of a larger task. ' +
        'You hold exactly the permissions of the node that spawned you, and the ' +
        'same working directory; calls outside them are denied. Do the piece you ' +
        'were given, then report what you found or changed. Be terse.',
      tools: allowedTools(caps),
      permissionMode: 'default',
    },
  };
}
