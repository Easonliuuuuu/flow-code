import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExecuteContext, NodeExecutor } from '../engine/types.js';
import { detectTestCommands } from '../init/testDetect.js';
import {
  discoverTestCommandsWithAgent,
  type TestCommandProposal,
} from '../init/testDiscoverAgent.js';
import { PLACEHOLDER_TEST_COMMAND, TEST_COMMANDS_AUTO, type TestConfig } from '../registry/index.js';
import { WORKFLOW_RELATIVE_PATH } from '../workflow/load.js';
import { setNodeTestCommands } from '../workflow/write.js';
import { nodeModel } from './helpers.js';

interface CommandResult {
  command: string;
  exitStatus: number | null;
  output: string;
}

function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 512 * 1024) output = output.slice(-512 * 1024);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ command, exitStatus: code, output }));
    child.on('error', (err) =>
      resolve({
        command,
        exitStatus: null,
        output: err.name === 'AbortError' ? 'interrupted' : `failed to spawn: ${err.message}`,
      }),
    );
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
async function commandsFor(ctx: ExecuteContext, config: TestConfig): Promise<string[]> {
  if (config.commands !== TEST_COMMANDS_AUTO) return config.commands;

  const release = await ctx.acquireSessionSlot();
  try {
    const proposals = await discoverWithAgent(ctx);
    return proposals.map((p) => p.command);
  } finally {
    release();
  }
}

function discoverWithAgent(ctx: ExecuteContext): Promise<TestCommandProposal[]> {
  const model = nodeModel(ctx, undefined);
  return discoverTestCommandsWithAgent({
    repoRoot: ctx.workingDir,
    sessions: ctx.sessions,
    ...(model !== undefined ? { model } : {}),
  });
}

/** True while this node still carries exactly the command `init` scaffolded. */
function isPlaceholder(config: TestConfig): boolean {
  const { commands } = config;
  return (
    Array.isArray(commands) && commands.length === 1 && commands[0] === PLACEHOLDER_TEST_COMMAND
  );
}

/**
 * Ask the user what this node should run, the first time it actually reaches
 * execution still holding the scaffolded placeholder.
 *
 * Deliberately here and not in `flow-code run`'s startup: asking before the
 * run has begun means asking before the Discuss node has established what is
 * being built, and from a console prompt that fights the terminal UI for the
 * screen. By the time a Test node executes, the discussion has happened and
 * the agent doing the looking has that context.
 *
 * The answer is written back to `workflow.yaml`, so this is asked once per
 * project rather than once per run.
 */
async function resolvePlaceholder(ctx: ExecuteContext): Promise<string[] | null> {
  const chosen = await ctx.ports.testCommands.request({
    nodeId: ctx.node.id,
    detected: detectTestCommands(ctx.repoRoot),
    discover: async () => {
      const release = await ctx.acquireSessionSlot();
      try {
        return await discoverWithAgent(ctx);
      } finally {
        release();
      }
    },
  });
  if (chosen === null || chosen.length === 0) return null;

  // Persisted before running anything: a command good enough to run is good
  // enough to keep, and a run interrupted mid-suite shouldn't ask again.
  setNodeTestCommands(join(ctx.repoRoot, WORKFLOW_RELATIVE_PATH), ctx.node.id, chosen);
  ctx.node.config = { ...(ctx.node.config as Record<string, unknown>), commands: chosen };
  return chosen;
}

/**
 * Deterministic command runner: no agent session, no API cost. Commands run
 * in order in the node's working directory; the first failure stops the node.
 */
export const executeTest: NodeExecutor = async function* (ctx) {
  yield { type: 'status', status: 'running' };
  let config = ctx.node.config as TestConfig;
  const results: CommandResult[] = [];

  if (isPlaceholder(config)) {
    yield { type: 'status', status: 'waiting', detail: 'no test command set yet' };
    const resolved = await resolvePlaceholder(ctx);
    if (resolved === null) {
      // Not a failure: a project with no test command yet is a real project,
      // and the alternative is failing every run until one exists.
      yield { type: 'output', text: 'no test command configured — nothing to run\n' };
      yield { type: 'result', output: { passed: true, commands: [] } };
      yield { type: 'status', status: 'done', detail: 'no test command configured' };
      return;
    }
    config = ctx.node.config as TestConfig;
    yield { type: 'status', status: 'running' };
  }

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
