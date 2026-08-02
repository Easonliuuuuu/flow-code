import { query, } from '@anthropic-ai/claude-agent-sdk';
import { compileToolPolicy } from '../harness/compile.js';
import { createInterceptor } from '../harness/intercept.js';
import { RunInterruptedError, } from '../engine/types.js';
function assistantText(message) {
    if (message.type !== 'assistant')
        return '';
    const content = message.message.content;
    if (!Array.isArray(content))
        return typeof content === 'string' ? content : '';
    return content
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
        .join('');
}
function extractExitStatus(toolResponse) {
    if (toolResponse === null || typeof toolResponse !== 'object')
        return undefined;
    const r = toolResponse;
    for (const key of ['exitCode', 'exit_code', 'code', 'returnCode']) {
        const v = r[key];
        if (typeof v === 'number')
            return v;
        if (v === null)
            return null;
    }
    return undefined;
}
/**
 * The SDK wants an owned AbortController, not a signal — proxy our shared
 * run-wide signal into a fresh one so aborting it kills this session's
 * underlying process.
 */
function controllerFor(signal) {
    if (!signal)
        return undefined;
    const controller = new AbortController();
    if (signal.aborted)
        controller.abort();
    else
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
}
function buildOptions(req, interceptor, abortController) {
    const policy = compileToolPolicy(req.capabilities, req.workingDir);
    return {
        cwd: req.workingDir,
        ...(abortController ? { abortController } : {}),
        ...(req.model !== undefined ? { model: req.model } : {}),
        ...(req.resumeSessionId !== undefined ? { resume: req.resumeSessionId } : {}),
        systemPrompt: `${req.rolePrompt}\n\n${policy.boundaryPrompt}`,
        disallowedTools: policy.disallowedTools,
        env: { ...process.env, ...policy.env },
        permissionMode: 'default',
        // Layer 3 enforcement + activity logging: fires for every tool call.
        hooks: {
            PreToolUse: [
                {
                    hooks: [
                        async (input, toolUseID) => {
                            const pre = input;
                            const decision = interceptor.check(pre.tool_name, (pre.tool_input ?? {}), toolUseID !== undefined ? { toolUseID } : undefined);
                            if (decision.behavior === 'deny') {
                                return {
                                    hookSpecificOutput: {
                                        hookEventName: 'PreToolUse',
                                        permissionDecision: 'deny',
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
                        async (input, toolUseID) => {
                            const post = input;
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
class PushQueue {
    values = [];
    resolvers = [];
    closed = false;
    push(value) {
        const resolver = this.resolvers.shift();
        if (resolver)
            resolver({ value, done: false });
        else
            this.values.push(value);
    }
    close() {
        this.closed = true;
        for (const r of this.resolvers.splice(0))
            r({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const value = this.values.shift();
                if (value !== undefined)
                    return Promise.resolve({ value, done: false });
                if (this.closed)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => this.resolvers.push(resolve));
            },
        };
    }
}
function userMessage(text) {
    return {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
    };
}
/**
 * Drives the Claude Agent SDK directly (no interactive `claude` shell-out),
 * with the capability harness compiled into every session.
 */
export class SdkSessionRunner {
    async run(req, store) {
        if (req.signal?.aborted)
            throw new RunInterruptedError();
        const interceptor = createInterceptor({
            nodeId: req.nodeId,
            ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
            capabilities: req.capabilities,
            workingDir: req.workingDir,
            store,
        });
        const q = query({
            prompt: req.prompt,
            options: buildOptions(req, interceptor, controllerFor(req.signal)),
        });
        let finalText = '';
        try {
            for await (const message of q) {
                const text = assistantText(message);
                if (text.length > 0) {
                    finalText = text;
                    req.onText?.(text);
                }
                if (message.type === 'result') {
                    if (message.subtype === 'success' && message.result.length > 0) {
                        finalText = message.result;
                    }
                    else if (message.subtype !== 'success') {
                        throw new Error(`agent session failed: ${message.subtype}`);
                    }
                }
            }
        }
        catch (err) {
            if (req.signal?.aborted)
                throw new RunInterruptedError();
            throw err;
        }
        // The stream can also end quietly (no throw, no final 'result') when
        // aborted mid-turn — don't report that as a successful completion.
        if (req.signal?.aborted)
            throw new RunInterruptedError();
        return { finalText };
    }
    async openInteractive(req, store) {
        const interceptor = createInterceptor({
            nodeId: req.nodeId,
            ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
            capabilities: req.capabilities,
            workingDir: req.workingDir,
            store,
        });
        const inputQueue = new PushQueue();
        const q = query({
            prompt: inputQueue,
            options: buildOptions(req, interceptor, controllerFor(req.signal)),
        });
        let turnText = '';
        const pendingTurns = [];
        const settleAll = (err) => {
            const reason = req.signal?.aborted ? new RunInterruptedError() : err;
            for (const turn of pendingTurns.splice(0))
                turn.reject(reason);
        };
        let sessionIdReported = false;
        const pump = (async () => {
            try {
                for await (const message of q) {
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
            }
            catch (err) {
                settleAll(err);
            }
        })();
        return {
            send(userText) {
                if (req.signal?.aborted)
                    return Promise.reject(new RunInterruptedError());
                return new Promise((resolve, reject) => {
                    pendingTurns.push({ resolve, reject });
                    inputQueue.push(userMessage(userText));
                });
            },
            async end() {
                inputQueue.close();
                await Promise.race([pump, new Promise((r) => setTimeout(r, 5000))]);
            },
        };
    }
}
//# sourceMappingURL=sdkRunner.js.map