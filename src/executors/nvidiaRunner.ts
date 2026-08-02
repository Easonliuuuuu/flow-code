import { compileToolPolicy } from '../harness/compile.js';
import { createNvidiaInterceptor } from '../harness/nvidiaIntercept.js';
import { nvidiaBoundaryPrompt, toolsForCapabilities } from '../harness/nvidiaTools.js';
import type { RunStateStore } from '../runstate/store.js';
import {
  RunInterruptedError,
  type AgentSessionRequest,
  type InteractiveAgentSession,
  type SessionRunner,
} from '../engine/types.js';
import {
  callNvidiaChat,
  DEFAULT_NVIDIA_MODEL,
  nvidiaApiKey,
  type NvidiaMessage,
} from './nvidiaClient.js';
import {
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from './nvidiaToolExec.js';

/** Fails a run rather than looping forever against a model that never stops calling tools. */
const MAX_TOOL_LOOP_ITERATIONS = 40;

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  shellEnv: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ text: string; exitStatus?: number | null }> {
  switch (name) {
    case 'read_file':
      return { text: readFileTool(workingDir, args) };
    case 'list_dir':
      return { text: listDirTool(workingDir, args) };
    case 'glob':
      return { text: globTool(workingDir, args) };
    case 'grep':
      return { text: grepTool(workingDir, args) };
    case 'write_file':
      return { text: writeFileTool(workingDir, args) };
    case 'edit_file':
      return { text: editFileTool(workingDir, args) };
    case 'run_shell': {
      const result = await runShellTool(workingDir, args, shellEnv, signal);
      return { text: result.output, exitStatus: result.exitStatus };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function runToolLoop(req: AgentSessionRequest, store: RunStateStore): Promise<string> {
  const apiKey = nvidiaApiKey();
  if (apiKey === undefined) {
    throw new Error('NVIDIA_API_KEY is not set — this should have been caught by preflight.');
  }

  const interceptor = createNvidiaInterceptor({
    nodeId: req.nodeId,
    ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
    capabilities: req.capabilities,
    workingDir: req.workingDir,
    store,
  });
  const tools = toolsForCapabilities(req.capabilities);
  const shellEnv = compileToolPolicy(req.capabilities, req.workingDir).env;
  const model = req.model ?? DEFAULT_NVIDIA_MODEL;

  const messages: NvidiaMessage[] = [
    { role: 'system', content: `${req.rolePrompt}\n\n${nvidiaBoundaryPrompt(req.capabilities, req.workingDir)}` },
    { role: 'user', content: req.prompt },
  ];

  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
    if (req.signal?.aborted) throw new RunInterruptedError();
    const message = await callNvidiaChat({
      model,
      messages,
      tools,
      apiKey,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    messages.push(message);

    if (message.tool_calls === undefined || message.tool_calls.length === 0) {
      const finalText = message.content ?? '';
      req.onText?.(finalText);
      return finalText;
    }

    if (message.content) req.onText?.(message.content);

    for (const call of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // Malformed arguments: fed back below as an error, not thrown — same
        // "denial is an event, not a crash" spirit as a capability denial.
      }

      const decision = interceptor.check(call.function.name, args, call.id);
      let resultText: string;
      if (decision.behavior === 'deny') {
        resultText = decision.message ?? 'denied by flow-code';
      } else {
        const start = Date.now();
        try {
          const { text, exitStatus } = await executeTool(
            call.function.name,
            args,
            req.workingDir,
            shellEnv,
            req.signal,
          );
          resultText = text;
          interceptor.complete(call.id, {
            durationMs: Date.now() - start,
            ...(exitStatus !== undefined ? { exitStatus } : {}),
          });
        } catch (err) {
          resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
          interceptor.complete(call.id, { durationMs: Date.now() - start, error: resultText });
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  throw new Error(
    `NVIDIA agent session for node "${req.nodeId}" exceeded ${MAX_TOOL_LOOP_ITERATIONS} tool-call iterations without finishing.`,
  );
}

/**
 * SessionRunner backed by NVIDIA's OpenAI-compatible NIM chat-completions
 * API. Brings its own tool-calling loop and capability enforcement (see
 * harness/nvidiaTools.ts, harness/nvidiaIntercept.ts) since NVIDIA's API has
 * no built-in tools or permission-hook system the way the Claude Agent SDK
 * does. Non-interactive only — see openInteractive().
 */
export class NvidiaSessionRunner implements SessionRunner {
  async run(req: AgentSessionRequest, store: RunStateStore): Promise<{ finalText: string }> {
    const finalText = await runToolLoop(req, store);
    return { finalText };
  }

  async openInteractive(
    _req: AgentSessionRequest,
    _store: RunStateStore,
  ): Promise<InteractiveAgentSession> {
    throw new Error(
      'NvidiaSessionRunner does not support interactive sessions — Discuss routes to the Claude Agent SDK runner.',
    );
  }
}
