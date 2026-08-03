import { Codex, type Thread, type ThreadEvent, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';
import type { CapabilitySet } from '../capabilities.js';
import type { RunStateStore } from '../runstate/store.js';
import type { ActivityEntry } from '../runstate/types.js';
import {
  RunInterruptedError,
  type AgentSessionRequest,
  type InteractiveAgentSession,
  type SessionRunner,
} from '../engine/types.js';

/**
 * Codex has no per-tool-call approve/deny hook the way the Claude Agent SDK
 * and the OpenAI-compat runners do — enforcement is a thread-wide sandbox
 * mode instead. `edit`/`git-write` need real file writes; everything else
 * (read, exec, git-read) still runs shell commands, just sandboxed against
 * writing anything.
 */
function sandboxModeFor(caps: CapabilitySet): 'read-only' | 'workspace-write' {
  return caps.has('edit') || caps.has('git-write') ? 'workspace-write' : 'read-only';
}

function boundaryPrompt(req: AgentSessionRequest): string {
  const lines = [
    'Capability boundary (enforced structurally, outside this prompt):',
    `- You may only operate inside ${req.workingDir}.`,
    '- Network access and web search are unavailable.',
  ];
  if (sandboxModeFor(req.capabilities) === 'read-only') {
    lines.push('- This session is sandboxed read-only: file writes are blocked at the OS level.');
  }
  return lines.join('\n');
}

function threadOptionsFor(req: AgentSessionRequest): ThreadOptions {
  return {
    workingDirectory: req.workingDir,
    sandboxMode: sandboxModeFor(req.capabilities),
    // Every built-in node type is non-interactive by design (the discuss
    // node is the only interactive one, and asks the user, not Codex, for
    // approval) — sandbox mode is the enforcement, not a prompt mid-run.
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchEnabled: false,
    // flow-code always runs inside a real checkout or worktree, but a
    // worktree's git metadata layout can trip Codex's own repo heuristic.
    skipGitRepoCheck: true,
    ...(req.model !== undefined ? { model: req.model } : {}),
  };
}

/** Turns a tool-shaped completed item into an activity-log entry; undefined for message/reasoning/todo items. */
function summarizeItem(item: ThreadItem): { tool: string; summary: string; exitStatus?: number | null } | undefined {
  switch (item.type) {
    case 'command_execution':
      return {
        tool: 'run_shell',
        summary: item.command.length > 300 ? `${item.command.slice(0, 300)}…` : item.command,
        exitStatus: item.exit_code ?? null,
      };
    case 'file_change':
      return { tool: 'edit_file', summary: item.changes.map((c) => `${c.kind} ${c.path}`).join(', ') };
    case 'mcp_tool_call':
      return { tool: `${item.server}.${item.tool}`, summary: JSON.stringify(item.arguments).slice(0, 300) };
    case 'web_search':
      return { tool: 'web_search', summary: item.query };
    default:
      return undefined;
  }
}

/**
 * Drains one streamed turn: forwards agent-message text via `onText`, logs
 * tool-shaped items to the activity feed (always 'allowed' — there is no
 * denial path at this layer, see `sandboxModeFor`), and reports token usage
 * once the turn completes. Throws on a thread-level error or turn failure.
 */
async function drainTurn(
  events: AsyncGenerator<ThreadEvent>,
  req: AgentSessionRequest,
  store: RunStateStore,
): Promise<{ finalText: string }> {
  let finalText = '';
  const startedAt = new Map<string, number>();

  for await (const event of events) {
    if (req.signal?.aborted) throw new RunInterruptedError();

    switch (event.type) {
      case 'item.started':
        startedAt.set(event.item.id, Date.now());
        break;
      case 'item.completed': {
        const item = event.item;
        if (item.type === 'agent_message') {
          finalText = item.text;
          req.onText?.(item.text);
        } else if (item.type === 'error') {
          throw new Error(`codex: ${item.message}`);
        } else {
          const summarized = summarizeItem(item);
          if (summarized) {
            const start = startedAt.get(item.id);
            const entry: ActivityEntry = {
              ts: new Date().toISOString(),
              nodeId: req.nodeId,
              ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
              tool: summarized.tool,
              summary: summarized.summary,
              decision: 'allowed',
              ...(start !== undefined ? { durationMs: Date.now() - start } : {}),
              ...(summarized.exitStatus !== undefined ? { exitStatus: summarized.exitStatus } : {}),
            };
            store.appendActivity(entry);
          }
        }
        break;
      }
      case 'turn.completed':
        store.addTokens(req.nodeId, {
          input: event.usage.input_tokens,
          output: event.usage.output_tokens + event.usage.reasoning_output_tokens,
          cached: event.usage.cached_input_tokens + event.usage.cache_write_input_tokens,
        });
        break;
      case 'turn.failed':
        throw new Error(`codex: ${event.error.message}`);
      case 'error':
        throw new Error(`codex: ${event.message}`);
    }
  }

  return { finalText };
}

function reportThreadId(thread: Thread, req: AgentSessionRequest): void {
  if (thread.id) req.onSessionId?.(thread.id);
}

/**
 * SessionRunner backed by OpenAI's Codex SDK, which wraps the `codex` CLI as
 * a subprocess exchanging JSONL over stdin/stdout, rather than an HTTP API
 * flow-code calls directly. Auth is the CLI's own resolution — an existing
 * `codex` login (ChatGPT Plus/Pro/Business subscription, mirroring how the
 * `claude` runner works) or OPENAI_API_KEY/CODEX_API_KEY in the environment.
 * Neither `Codex` options here set `apiKey` or `env` explicitly, so the
 * subprocess inherits the parent's environment and whatever login state
 * already exists on disk — flow-code never handles a codex credential
 * itself, same as it never handles one for `claude`.
 *
 * Threads are real, resumable sessions (persisted under `~/.codex/sessions`
 * by the CLI itself), so `openInteractive`'s `--resume` support is a genuine
 * `resumeThread`, not a replayed transcript the way the OpenAI-compat runner
 * has to fake it.
 */
export class CodexSessionRunner implements SessionRunner {
  private readonly codex = new Codex();

  async run(req: AgentSessionRequest, store: RunStateStore): Promise<{ finalText: string }> {
    const thread = this.codex.startThread(threadOptionsFor(req));
    const input = `${req.rolePrompt}\n\n${boundaryPrompt(req)}\n\n${req.prompt}`;
    const { events } = await thread.runStreamed(input, { ...(req.signal ? { signal: req.signal } : {}) });
    const result = await drainTurn(events, req, store);
    reportThreadId(thread, req);
    return result;
  }

  async openInteractive(req: AgentSessionRequest, store: RunStateStore): Promise<InteractiveAgentSession> {
    const resuming = req.resumeSessionId !== undefined;
    const thread = resuming
      ? this.codex.resumeThread(req.resumeSessionId!, threadOptionsFor(req))
      : this.codex.startThread(threadOptionsFor(req));

    let firstTurn = !resuming;
    let sessionIdReported = resuming;

    return {
      async send(userText: string): Promise<string> {
        if (req.signal?.aborted) throw new RunInterruptedError();
        const input = firstTurn ? `${req.rolePrompt}\n\n${boundaryPrompt(req)}\n\n${userText}` : userText;
        firstTurn = false;
        const { events } = await thread.runStreamed(input, { ...(req.signal ? { signal: req.signal } : {}) });
        const { finalText } = await drainTurn(events, req, store);
        if (!sessionIdReported && thread.id) {
          sessionIdReported = true;
          reportThreadId(thread, req);
        }
        return finalText;
      },
      async end(): Promise<void> {
        // The CLI persists the thread on disk on its own — nothing to tear down here.
      },
    };
  }
}
