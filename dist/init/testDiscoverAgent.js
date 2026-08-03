import { capabilitySet } from '../capabilities.js';
import { extractJson } from '../executors/helpers.js';
import { RunStateStore } from '../runstate/store.js';
const PROMPT = 'Work out how this project runs its automated tests.\n\n' +
    'Read whatever tells you: package manifests and their scripts, Makefile targets, CI workflow ' +
    'files, test-runner config (pytest.ini, tox.ini, pyproject.toml, go.mod, Cargo.toml, …), and the ' +
    'layout of any test directories. In a monorepo, prefer the command that runs the whole suite from ' +
    'the repository root.\n\n' +
    'Rules:\n' +
    '- Only propose commands that run tests to completion and exit. Never propose a watch mode, a ' +
    'REPL, a linter, a build, or anything that starts a long-running server.\n' +
    '- Never propose a command that resets a database, deletes files, or otherwise mutates state ' +
    'beyond what running tests requires.\n' +
    '- If the project genuinely has no tests yet, propose none. An empty list is a correct answer.\n\n' +
    'Respond with ONLY a JSON object:\n' +
    '{"commands": [{"command": "<shell command>", "rationale": "<one line: what in the repo this came from>"}]}';
const ROLE_PROMPT = 'You are setting up a coding workflow for this project. Your only job is to determine the ' +
    'command(s) that run its test suite. You may read the repository; you cannot change anything, ' +
    'and you must not run any command.';
/**
 * The `read`-only agent fallback for test-command detection.
 *
 * It proposes, it never decides: nothing here is executed, and nothing reaches
 * the workflow file without the user accepting it first. That matters more
 * than usual because the Test node runs its commands through `sh -c` outside
 * the capability harness — an unreviewed command string there is not sandboxed
 * by anything.
 */
export async function discoverTestCommandsWithAgent(opts) {
    const store = new RunStateStore({ repoRoot: opts.repoRoot, nodeIds: ['test-discovery'] });
    const { finalText } = await opts.sessions.run({
        nodeId: 'test-discovery',
        capabilities: capabilitySet('read'),
        rolePrompt: ROLE_PROMPT,
        prompt: PROMPT,
        workingDir: opts.repoRoot,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
    }, store);
    const parsed = extractJson(finalText);
    if (!Array.isArray(parsed.commands))
        return [];
    return parsed.commands
        .filter((c) => typeof c === 'object' &&
        c !== null &&
        typeof c.command === 'string' &&
        c.command.trim().length > 0)
        .map((c) => ({
        command: c.command.trim(),
        rationale: typeof c.rationale === 'string' ? c.rationale : '',
    }));
}
//# sourceMappingURL=testDiscoverAgent.js.map