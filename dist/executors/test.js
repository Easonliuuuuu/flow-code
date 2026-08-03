import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { discoverTestCommandsWithAgent } from '../init/testDiscoverAgent.js';
import { TEST_COMMANDS_AUTO } from '../registry/index.js';
import { nodeModel } from './helpers.js';
function runCommand(command, cwd, signal) {
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
        let output = '';
        const collect = (chunk) => {
            output += chunk.toString();
            if (output.length > 512 * 1024)
                output = output.slice(-512 * 1024);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('close', (code) => resolve({ command, exitStatus: code, output }));
        child.on('error', (err) => resolve({
            command,
            exitStatus: null,
            output: err.name === 'AbortError' ? 'interrupted' : `failed to spawn: ${err.message}`,
        }));
    });
}
/**
 * The commands this node will run. Normally that is exactly what its config
 * lists — no agent, no session slot, no tokens, and the same commands on every
 * run of the same file.
 *
 * `commands: auto` opts out of that, rediscovering them each execution with a
 * `read`-only session. The loader refuses to pair it with a loop-back that can
 * re-run the node, so a retry loop can never shop for an easier suite.
 */
async function commandsFor(ctx, config) {
    if (config.commands !== TEST_COMMANDS_AUTO)
        return config.commands;
    const release = await ctx.acquireSessionSlot();
    try {
        const model = nodeModel(ctx, undefined);
        const proposals = await discoverTestCommandsWithAgent({
            repoRoot: ctx.workingDir,
            sessions: ctx.sessions,
            ...(model !== undefined ? { model } : {}),
        });
        return proposals.map((p) => p.command);
    }
    finally {
        release();
    }
}
/**
 * Deterministic command runner: no agent session, no API cost. Commands run
 * in order in the node's working directory; the first failure stops the node.
 */
export const executeTest = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    const results = [];
    const commands = await commandsFor(ctx, config);
    if (commands.length === 0 && config.commands === TEST_COMMANDS_AUTO) {
        yield { type: 'output', text: 'no test command could be determined for this project\n' };
        yield { type: 'result', output: { passed: false, commands: [] } };
        yield { type: 'status', status: 'error', detail: 'no test command could be determined' };
        return;
    }
    for (const command of commands) {
        const toolUseId = randomUUID();
        ctx.store.appendActivity({
            ts: new Date().toISOString(),
            nodeId: ctx.node.id,
            tool: 'command',
            summary: command,
            decision: 'allowed',
            toolUseId,
        });
        const started = Date.now();
        const result = await runCommand(command, ctx.workingDir, ctx.signal);
        ctx.store.completeActivity(toolUseId, {
            durationMs: Date.now() - started,
            exitStatus: result.exitStatus,
        });
        results.push(result);
        yield {
            type: 'output',
            text: `$ ${command}\n${result.output}(exit ${result.exitStatus})\n`,
        };
        if (result.exitStatus !== 0) {
            yield { type: 'result', output: { passed: false, commands: results } };
            yield {
                type: 'status',
                status: 'error',
                detail: ctx.signal.aborted
                    ? 'interrupted'
                    : `command failed with exit ${result.exitStatus}: ${command}`,
            };
            return;
        }
    }
    yield { type: 'result', output: { passed: true, commands: results } };
    yield { type: 'status', status: 'done' };
};
//# sourceMappingURL=test.js.map