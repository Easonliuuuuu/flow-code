/**
 * Tool vocabulary offered to the NVIDIA-backed runner via OpenAI-style
 * function calling. Independent of compile.ts on purpose (see design.md):
 * NVIDIA's chat-completions API has no built-in tools, so flow-code owns the
 * full tool surface, not just a Claude tool allow/deny list.
 */
import type { CapabilitySet } from '../capabilities.js';

export interface NvidiaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const READ_TOOL_NAMES = ['read_file', 'list_dir', 'glob', 'grep'] as const;
export const EDIT_TOOL_NAMES = ['write_file', 'edit_file'] as const;
export const EXEC_TOOL_NAMES = ['run_shell'] as const;

const READ_TOOLS: NvidiaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file relative to the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the working directory' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries (files and subdirectories) in a directory relative to the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the working directory; omit for the root' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files matching a glob pattern (supports * and **) relative to the working directory.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'e.g. "**/*.ts"' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a regular expression under the working directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression' },
          path: { type: 'string', description: 'Subdirectory to search; omit to search the whole working directory' },
        },
        required: ['pattern'],
      },
    },
  },
];

const EDIT_TOOLS: NvidiaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file or overwrite it entirely with new content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace one exact, unique occurrence of old_string with new_string in an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
];

const EXEC_TOOLS: NvidiaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command in the working directory.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function bashAvailable(caps: CapabilitySet): boolean {
  return caps.has('exec') || caps.has('git-read') || caps.has('git-write');
}

/** Layer 2 equivalent to compile.ts's disallowedTools: only offer tools the capability set allows. */
export function toolsForCapabilities(caps: CapabilitySet): NvidiaToolDef[] {
  const tools: NvidiaToolDef[] = [];
  if (caps.has('read')) tools.push(...READ_TOOLS);
  if (caps.has('edit')) tools.push(...EDIT_TOOLS);
  if (bashAvailable(caps)) tools.push(...EXEC_TOOLS);
  return tools;
}

/** Layer 1: states the boundary in the system prompt. Guarantees nothing — see nvidiaIntercept.ts for layer 3. */
export function nvidiaBoundaryPrompt(caps: CapabilitySet, workingDir: string): string {
  const lines: string[] = [
    'Capability boundary (enforced structurally, outside this prompt):',
    `- You may only operate inside ${workingDir}. File access outside it is denied.`,
    '- Network tools are unavailable; only the tools offered to you in this session exist.',
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
  return lines.join('\n');
}
