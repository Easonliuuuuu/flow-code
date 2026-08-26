/** Translate Codex's local tool names into flow-code's shared policy names. */

export interface NormalizedHostCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  repositoryMutation?: boolean;
}

export interface CodexToolNormalization {
  calls?: NormalizedHostCall[];
  error?: string;
}

const SUBAGENT_TOOLS = new Set(['spawn_agent', 'send_input', 'wait_agent', 'resume_agent', 'close_agent']);

/**
 * Codex's patch tool carries a patch document rather than a single file path.
 * Checking every declared path is important: checking only the first file
 * would let a multi-file patch cross the node boundary on its second hunk.
 */
export function applyPatchPaths(input: Record<string, unknown>): string[] {
  const patch = typeof input['patch'] === 'string' ? input['patch'] : input['command'];
  if (typeof patch !== 'string') return [];
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const path = match[1]?.trim();
    if (path) paths.push(path);
  }
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    const path = match[1]?.trim();
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

export function normalizeCodexTool(
  toolName: string,
  input: Record<string, unknown>,
): CodexToolNormalization {
  if (toolName === 'Bash' || toolName === 'exec_command') {
    const command = typeof input['command'] === 'string' ? input['command'] : input['cmd'];
    if (typeof command !== 'string') return { error: `${toolName} did not include a shell command.` };
    return { calls: [{ toolName: 'Bash', toolInput: { ...input, command } }] };
  }

  if (toolName === 'apply_patch') {
    const paths = applyPatchPaths(input);
    if (paths.length === 0) {
      return { error: 'apply_patch did not declare a file path in its patch document.' };
    }
    return {
      calls: paths.map((filePath) => ({
        toolName: 'Edit',
        toolInput: { file_path: filePath },
        repositoryMutation: true,
      })),
    };
  }

  if (toolName === 'view_image') {
    const path = input['path'];
    return typeof path === 'string'
      ? { calls: [{ toolName: 'Read', toolInput: { file_path: path } }] }
      : { error: 'view_image did not include an image path.' };
  }

  if (SUBAGENT_TOOLS.has(toolName)) return { calls: [{ toolName: 'Agent', toolInput: input }] };
  if (toolName === 'request_user_input') return { calls: [{ toolName: 'AskUserQuestion', toolInput: input }] };
  if (toolName === 'update_plan') return { calls: [{ toolName: 'TodoWrite', toolInput: input }] };

  return { error: `Codex tool ${toolName} is not an observable local tool supported by flow-code.` };
}
