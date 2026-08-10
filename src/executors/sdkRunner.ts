import {
  query,
  type HookInput,
  type Options,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { compileSubagents, compileToolPolicy } from '../harness/compile.js';
import { createInterceptor, type Interceptor } from '../harness/intercept.js';
import type { RunStateStore } from '../runstate/store.js';
import {
  RunInterruptedError,
  type AgentSessionRequest,
  type InteractiveAgentSession,
  type SessionRunner,
} from '../engine/types.js';
import { SubagentScope } from '../engine/slots.js';
import type { SubagentStartHookInput, SubagentStopHookInput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Text from the node's own session only.
 *
 * A subagent's assistant messages carry `parent_tool_use_id` and do reach this
 * stream — observed, not assumed, and observed with `forwardSubagentText`
 * unset. Letting them through would overwrite `finalText`, which is what
 * Validate and Review parse their verdict out of, so a delegated aside could
 * silently displace the verdict the run routes on.
 */
function assistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return '';
  const content = message.message.content;
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/**
 * Per-response token usage off an assistant message. Only assistant messages
 * are counted: the terminal `result` message reports usage cumulatively for
 * the whole session, so adding that too would double every turn.
 */
function reportUsage(message: SDKMessage, nodeId: string, store: RunStateStore): void {
  if (message.type !== 'assistant') return;
  const usage = message.message.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | undefined;
  if (!usage) return;
  store.addTokens(nodeId, {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  });
}

/**
 * Plan rate-limit utilization, straight from the provider. Each event carries
 * one window, so this merges rather than replaces (see `recordRateLimit`).
 *
 * Only reported on claude.ai subscription sessions — API-key, Bedrock and
 * Vertex sessions never emit these, which is exactly why the UI treats a
 * missing meter as unknown rather than as zero.
 *
 * The event also carries a `resetsAt`, deliberately not recorded here: the SDK
 * types it as a bare number without stating its epoch unit, and an unverified
 * timestamp in persisted state is worse than an absent one.
 */
function reportRateLimit(message: SDKMessage, store: RunStateStore): void {
  if (message.type !== 'rate_limit_event') return;
  const info = message.rate_limit_info;
  if (info.rateLimitType === undefined || info.utilization === undefined) return;
  store.recordRateLimit(info.rateLimitType, {
    utilization: info.utilization,
    status: info.status,
  });
}

function extractExitStatus(toolResponse: unknown): number | null | undefined {
  if (toolResponse === null || typeof toolResponse !== 'object') return undefined;
  const r = toolResponse as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'code', 'returnCode']) {
    const v = r[key];
    if (typeof v === 'number') return v;
    if (v === null) return null;
  }
  return undefined;
}

/**
 * The SDK wants an owned AbortController, not a signal — proxy our shared
 * run-wide signal into a fresh one so aborting it kills this session's
 * underlying process.
 */
function controllerFor(signal: AbortSignal | undefined): AbortController | undefined {
  if (!signal) return undefined;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

/**
 * The agent types this session may spawn. Derived from the same compile step
 * that builds the SDK's registry, so what the model is offered and what the
 * interceptor will accept cannot drift apart.
 */
function subagentTypesFor(req: AgentSessionRequest): ReadonlySet<string> {
  return new Set(Object.keys(compileSubagents(req.capabilities, { enabled: req.subagents ?? false })));
}

function buildOptions(
  req: AgentSessionRequest,
  interceptor: Interceptor,
  abortController: AbortController | undefined,
  scope: SubagentScope,
  store: RunStateStore,
): Options {
  const policy = compileToolPolicy(req.capabilities, req.workingDir);
  const agents = compileSubagents(req.capabilities, { enabled: req.subagents ?? false });

  return {
    cwd: req.workingDir,
    agents,
    ...(abortController ? { abortController } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.resumeSessionId !== undefined ? { resume: req.resumeSessionId } : {}),
    systemPrompt: `${req.rolePrompt}\n\n${policy.boundaryPrompt}`,
    disallowedTools: policy.disallowedTools,
    env: { ...process.env, ...policy.env },
    permissionMode: 'default',
    // Left unset, the SDK loads the operator's own ~/.claude/settings.json
    // plus project/local settings (its documented CLI-matching default) —
    // whatever skills, plugins, and deferred tools happen to be configured on
    // the machine running flow-code would leak into every node's tool
    // surface, on top of what compileToolPolicy/compileSubagents compiled.
    // The capability harness is supposed to be the sole source of truth for
    // what a node may do, so nested sessions are isolated from it entirely.
    settingSources: [],
    // Layer 3 enforcement + activity logging: fires for every tool call.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: HookInput, toolUseID: string | undefined) => {
              const pre = input as PreToolUseHookInput;
              // `agent_id` is present only when the hook fires from inside a
              // subagent, so its absence is what marks a call as the node's
              // own session — no separate flag needed.
              const decision = interceptor.check(
                pre.tool_name,
                (pre.tool_input ?? {}) as Record<string, unknown>,
                {
                  ...(toolUseID !== undefined ? { toolUseID } : {}),
                  ...(pre.agent_id !== undefined ? { agentId: pre.agent_id } : {}),
                  ...(pre.agent_type !== undefined ? { agentType: pre.agent_type } : {}),
                },
              );
              if (decision.behavior === 'deny') {
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: decision.message ?? 'denied by flow-code',
                  },
                };
              }
              return {};
            },
          ],
        },
      ],
      // Binds each claimed slot to the subagent that actually started, and
      // returns it when that subagent finishes.
      SubagentStart: [
        {
          hooks: [
            async (input: HookInput) => {
              scope.started((input as SubagentStartHookInput).agent_id);
              store.addSubagents(req.nodeId, 1);
              return {};
            },
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            async (input: HookInput) => {
              scope.stopped((input as SubagentStopHookInput).agent_id);
              store.addSubagents(req.nodeId, -1);
              return {};
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input: HookInput, toolUseID: string | undefined) => {
              const post = input as PostToolUseHookInput;
              const id = post.tool_use_id ?? toolUseID;
              if (id !== undefined) {
                const exitStatus = extractExitStatus(post.tool_response);
                interceptor.complete(id, {
                  ...(post.duration_ms !== undefined ? { durationMs: post.duration_ms } : {}),
                  ...(exitStatus !== undefined ? { exitStatus } : {}),
                });
              }
              return {};
            },
          ],
        },
      ],
    },
    // Backstop for the permission-prompt path (e.g. blockedPath on Bash).
    canUseTool: async (toolName, input, opts) => {
      const decision = interceptor.promptCheck(toolName, input, {
        ...(opts.blockedPath !== undefined ? { blockedPath: opts.blockedPath } : {}),
        toolUseID: opts.toolUseID,
      });
      if (decision.behavior === 'deny') {
        return { behavior: 'deny', message: decision.message ?? 'denied by flow-code' };
      }
      return { behavior: 'allow' };
    },
  };
}

/** Simple push-based async iterable for streaming-input sessions. */
class PushQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const r of this.resolvers.splice(0)) r({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

/**
 * Drives the Claude Agent SDK directly (no interactive `claude` shell-out),
 * with the capability harness compiled into every session.
 */
export class SdkSessionRunner implements SessionRunner {
  async run(req: AgentSessionRequest, store: RunStateStore): Promise<{ finalText: string }> {
    if (req.signal?.aborted) throw new RunInterruptedError();
    const scope = new SubagentScope(req.subagentPool);
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      capabilities: req.capabilities,
      workingDir: req.workingDir,
      store,
      subagentTypes: subagentTypesFor(req),
      subagentSlots: scope,
    });

    const q = query({
      prompt: req.prompt,
      options: buildOptions(req, interceptor, controllerFor(req.signal), scope, store),
    });

    let finalText = '';
    try {
      for await (const message of q) {
        reportUsage(message, req.nodeId, store);
        reportRateLimit(message, store);
        const text = assistantText(message);
        if (text.length > 0) {
          finalText = text;
          req.onText?.(text);
        }
        if (message.type === 'result') {
          if (message.subtype === 'success' && message.result.length > 0) {
            finalText = message.result;
          } else if (message.subtype !== 'success') {
            throw new Error(`agent session failed: ${message.subtype}`);
          }
        }
      }
    } catch (err) {
      if (req.signal?.aborted) throw new RunInterruptedError();
      throw err;
    } finally {
      // Returns any slot a spawn claimed but never reported starting, so a
      // session cannot strand concurrency for the rest of the run. Subtracts
      // this session's own share of the node's in-flight count rather than
      // zeroing it — sibling worktree instances share the node id.
      store.addSubagents(req.nodeId, -scope.liveCount);
      scope.dispose();
    }
    // The stream can also end quietly (no throw, no final 'result') when
    // aborted mid-turn — don't report that as a successful completion.
    if (req.signal?.aborted) throw new RunInterruptedError();
    return { finalText };
  }

  async openInteractive(
    req: AgentSessionRequest,
    store: RunStateStore,
  ): Promise<InteractiveAgentSession> {
    const scope = new SubagentScope(req.subagentPool);
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      capabilities: req.capabilities,
      workingDir: req.workingDir,
      store,
      subagentTypes: subagentTypesFor(req),
      subagentSlots: scope,
    });

    const inputQueue = new PushQueue<SDKUserMessage>();
    const q = query({
      prompt: inputQueue,
      options: buildOptions(req, interceptor, controllerFor(req.signal), scope, store),
    });

    let turnText = '';
    const pendingTurns: Array<{
      resolve: (text: string) => void;
      reject: (err: unknown) => void;
    }> = [];

    const settleAll = (err: unknown): void => {
      const reason = req.signal?.aborted ? new RunInterruptedError() : err;
      for (const turn of pendingTurns.splice(0)) turn.reject(reason);
    };

    let sessionIdReported = false;
    const pump = (async () => {
      try {
        for await (const message of q) {
          reportUsage(message, req.nodeId, store);
          reportRateLimit(message, store);
          if (!sessionIdReported && message.session_id) {
            sessionIdReported = true;
            req.onSessionId?.(message.session_id);
          }
          const text = assistantText(message);
          if (text.length > 0) {
            turnText += (turnText.length > 0 ? '\n' : '') + text;
            req.onText?.(text);
          }
          if (message.type === 'result') {
            const finished = turnText;
            turnText = '';
            pendingTurns.shift()?.resolve(finished);
          }
        }
        // Stream ended without a result for a still-pending turn (e.g.
        // aborted mid-turn): don't leave it hanging forever.
        if (pendingTurns.length > 0) {
          settleAll(new Error('agent session ended before responding'));
        }
      } catch (err) {
        settleAll(err);
      } finally {
        store.addSubagents(req.nodeId, -scope.liveCount);
        scope.dispose();
      }
    })();

    return {
      send(userText: string): Promise<string> {
        if (req.signal?.aborted) return Promise.reject(new RunInterruptedError());
        return new Promise<string>((resolve, reject) => {
          pendingTurns.push({ resolve, reject });
          inputQueue.push(userMessage(userText));
        });
      },
      async end(): Promise<void> {
        inputQueue.close();
        await Promise.race([pump, new Promise((r) => setTimeout(r, 5000))]);
      },
    };
  }
}
