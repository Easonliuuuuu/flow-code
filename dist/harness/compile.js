export const READ_TOOLS = ['Read', 'Glob', 'Grep'];
export const EDIT_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
export const EXEC_TOOLS = ['Bash', 'BashOutput', 'KillShell'];
/** No built-in node type grants network access in v1. */
export const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];
/** Subagents would put tool calls outside the interception point. */
export const ALWAYS_DENIED_TOOLS = [...NETWORK_TOOLS, 'Task', 'Agent'];
/** Harmless bookkeeping the SDK may use regardless of capabilities. */
export const ALWAYS_ALLOWED_TOOLS = ['TodoWrite'];
function bashAvailable(caps) {
    return caps.has('exec') || caps.has('git-read') || caps.has('git-write');
}
/**
 * Layer 2: compile a capability set into the SDK's coarse tool deny list.
 * Layer 3 (the per-call interception check) lives in intercept.ts.
 */
export function compileToolPolicy(caps, workingDir) {
    const disallowed = new Set(ALWAYS_DENIED_TOOLS);
    if (!caps.has('read'))
        for (const t of READ_TOOLS)
            disallowed.add(t);
    if (!caps.has('edit'))
        for (const t of EDIT_TOOLS)
            disallowed.add(t);
    if (!bashAvailable(caps))
        for (const t of EXEC_TOOLS)
            disallowed.add(t);
    const lines = [
        'Capability boundary (enforced structurally, outside this prompt):',
        `- You may only operate inside ${workingDir}. File access outside it is denied.`,
        '- Network tools are unavailable.',
    ];
    if (!caps.has('edit'))
        lines.push('- You cannot create, edit, or delete files.');
    if (caps.has('exec')) {
        lines.push('- You may run shell commands, but git commands that mutate history, refs, or remotes are denied.');
    }
    else if (caps.has('git-write')) {
        lines.push('- Shell access is limited to git commands only.');
    }
    else if (caps.has('git-read')) {
        lines.push('- Shell access is limited to read-only git commands.');
    }
    else {
        lines.push('- You cannot run shell commands.');
    }
    if (!caps.has('git-write')) {
        lines.push('- Git operations that write (push, commit, merge, reset, …) are denied and will fail.');
    }
    lines.push('Denied calls return a tool error; note the denial and continue within your role.');
    const env = {};
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
export function capabilityList(caps) {
    return [...caps];
}
//# sourceMappingURL=compile.js.map