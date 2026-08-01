import {
  query,
  type HookInput,
  type Options,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { compileToolPolicy } from '../harness/compile.js';
import { createInterceptor, type Interceptor } from '../harness/intercept.js';
import type { RunStateStore } from '../runstate/store.js';
import type {
  AgentSessionRequest,
  InteractiveAgentSession,
  SessionRunner,
} from '../engine/types.js';

function assistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const content = message.message.content;
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('');
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

function buildOptions(req: AgentSessionRequest, interceptor: Interceptor): Options {
  const policy = compileToolPolicy(req.capabilities, req.workingDir);

  return {
    cwd: req.workingDir,
    ...(req.model !== undefined ? { model: req.model } : {}),
    systemPrompt: `${req.rolePrompt}\n\n${policy.boundaryPrompt}`,
    disallowedTools: policy.disallowedTools,
    env: { ...process.env, ...policy.env },
    permissionMode: 'default',
    // Layer 3 enforcement + activity logging: fires for every tool call.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: HookInput, toolUseID: string | undefined) => {
              const pre = input as PreToolUseHookInput;
              const decision = interceptor.check(
                pre.tool_name,
                (pre.tool_input ?? {}) as Record<string, unknown>,
                toolUseID !== undefined ? { toolUseID } : undefined,
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
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      capabilities: req.capabilities,
      workingDir: req.workingDir,
      store,
    });

    const q = query({ prompt: req.prompt, options: buildOptions(req, interceptor) });

    let finalText = '';
    for await (const message of q) {
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
    return { finalText };
  }

  async openInteractive(
    req: AgentSessionRequest,
    store: RunStateStore,
  ): Promise<InteractiveAgentSession> {
    const interceptor = createInterceptor({
      nodeId: req.nodeId,
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      capabilities: req.capabilities,
      workingDir: req.workingDir,
      store,
    });

    const inputQueue = new PushQueue<SDKUserMessage>();
    const q = query({ prompt: inputQueue, options: buildOptions(req, interceptor) });

    let turnText = '';
    const pendingTurns: Array<{
      resolve: (text: string) => void;
      reject: (err: unknown) => void;
    }> = [];

    const pump = (async () => {
      try {
        for await (const message of q) {
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
      } catch (err) {
        pendingTurns.shift()?.reject(err);
      }
    })();

    return {
      send(userText: string): Promise<string> {
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
