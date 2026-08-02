import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
 * Deterministic command runner: no agent session, no API cost. Commands run
 * in order in the node's working directory; the first failure stops the node.
 */
export const executeTest = async function* (ctx) {
    yield { type: 'status', status: 'running' };
    const config = ctx.node.config;
    const results = [];
    for (const command of config.commands) {
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