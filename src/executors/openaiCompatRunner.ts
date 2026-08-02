import { randomUUID } from 'node:crypto';
import { compileToolPolicy } from '../harness/compile.js';
import { createNvidiaInterceptor, type NvidiaInterceptor } from '../harness/nvidiaIntercept.js';
import { nvidiaBoundaryPrompt, toolsForCapabilities } from '../harness/nvidiaTools.js';
import type { RunStateStore } from '../runstate/store.js';
import {
  RunInterruptedError,
  type AgentSessionRequest,
  type InteractiveAgentSession,
  type SessionRunner,
} from '../engine/types.js';
import { callOpenAiCompatChat, type ChatMessage } from './openaiCompatClient.js';
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

export interface OpenAiCompatProviderConfig {
  readonly providerId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Env vars checked in order; every one that's set is used, in order, as a rotation pool on 429/5xx. */
  readonly apiKeyEnvVars: readonly string[];
}

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

function systemPrompt(req: AgentSessionRequest): string {
  return `${req.rolePrompt}\n\n${nvidiaBoundaryPrompt(req.capabilities, req.workingDir)}`;
}

function buildInterceptor(req: AgentSessionRequest, store: RunStateStore): NvidiaInterceptor {
  return createNvidiaInterceptor({
    nodeId: req.nodeId,
    ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
    capabilities: req.capabilities,
    workingDir: req.workingDir,
    store,
  });
}

/**
 * Runs one turn to completion: calls the model, executes any tool calls it
 * requests (appending results back into `messages`), and repeats until it
 * answers with plain text. `messages` is mutated in place so interactive
 * callers can keep accumulating history across turns.
 */
async function runTurn(
  config: OpenAiCompatProviderConfig,
  messages: ChatMessage[],
  req: AgentSessionRequest,
  apiKeys: string[],
  interceptor: NvidiaInterceptor,
  store: RunStateStore,
): Promise<string> {
  const tools = toolsForCapabilities(req.capabilities);
  const shellEnv = compileToolPolicy(req.capabilities, req.workingDir).env;
  const model = req.model ?? config.defaultModel;

  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
    if (req.signal?.aborted) throw new RunInterruptedError();
    const message = await callOpenAiCompatChat({
      baseUrl: config.baseUrl,
      model,
      messages,
      tools,
      apiKeys,
      onUsage: (usage) => store.addTokens(req.nodeId, usage),
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
    `${config.label} agent session for node "${req.nodeId}" exceeded ${MAX_TOOL_LOOP_ITERATIONS} tool-call iterations without finishing.`,
  );
}

/**
 * SessionRunner backed by any OpenAI-compatible chat-completions API (NVIDIA
 * NIM, OpenAI, OpenRouter, …). Brings its own tool-calling loop and
 * capability enforcement (see harness/nvidiaTools.ts, harness/nvidiaIntercept.ts)
 * since these APIs have no built-in tools or permission-hook system the way
 * the Claude Agent SDK does.
 *
 * Interactive sessions (openInteractive) have no server-side session to
 * resume, unlike the Claude SDK — on `--resume` the prior Discuss transcript
 * is replayed into the message history instead.
 */
export class OpenAiCompatSessionRunner implements SessionRunner {
  constructor(private readonly config: OpenAiCompatProviderConfig) {}

  private requireApiKeys(): string[] {
    const apiKeys = this.config.apiKeyEnvVars
      .map((envVar) => process.env[envVar])
      // GitHub Actions sets a referenced-but-unconfigured secret to '' rather
      // than leaving the env var unset, so treat empty the same as absent.
      .filter((value): value is string => value !== undefined && value !== '');
    if (apiKeys.length === 0) {
      throw new Error(`${this.config.apiKeyEnvVars[0]} is not set — this should have been caught by preflight.`);
    }
    return apiKeys;
  }

  async run(req: AgentSessionRequest, store: RunStateStore): Promise<{ finalText: string }> {
    const apiKeys = this.requireApiKeys();
    const config = this.config;
    const interceptor = buildInterceptor(req, store);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(req) },
      { role: 'user', content: req.prompt },
    ];
    const finalText = await runTurn(config, messages, req, apiKeys, interceptor, store);
    return { finalText };
  }

  async openInteractive(req: AgentSessionRequest, store: RunStateStore): Promise<InteractiveAgentSession> {
    const apiKeys = this.requireApiKeys();
    const config = this.config;
    const interceptor = buildInterceptor(req, store);
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(req) }];

    if (req.resumeSessionId !== undefined) {
      for (const entry of store.node(req.nodeId).discussTranscript ?? []) {
        messages.push({ role: entry.role, content: entry.text });
      }
    }
    req.onSessionId?.(randomUUID());

    return {
      send(userText: string): Promise<string> {
        if (req.signal?.aborted) return Promise.reject(new RunInterruptedError());
        messages.push({ role: 'user', content: userText });
        return runTurn(config, messages, req, apiKeys, interceptor, store);
      },
      async end(): Promise<void> {
        // No server-side session to tear down — nothing to do.
      },
    };
  }
}
