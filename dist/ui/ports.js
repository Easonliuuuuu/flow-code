import { RunInterruptedError } from '../engine/types.js';
/**
 * The UI side of the engine's interaction ports: executors block on promises
 * that the App resolves from key presses. The engine never imports this —
 * headless runs substitute any other InteractionPorts implementation.
 */
export class UiInteractionPorts {
    signal;
    pendingApproval = null;
    pendingConvergence = null;
    pendingTestCommands = null;
    /**
     * Replaced wholesale on every change (never mutated in place): the App
     * memoizes the rendered transcript on this object's identity, so an
     * in-place push would leave new messages invisible on screen.
     */
    discussState = null;
    nextMessageResolve = null;
    listeners = new Set();
    /** Aborted when the run is interrupted (e.g. ctrl+c); rejects any pending wait on the user. */
    constructor(signal) {
        this.signal = signal;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    notify() {
        for (const l of this.listeners)
            l();
    }
    /** Rejects `reject` (and runs `onAbort`) the moment the run is interrupted. */
    onInterrupt(reject, onAbort) {
        if (!this.signal)
            return;
        const fire = () => {
            onAbort();
            this.notify();
            reject(new RunInterruptedError());
        };
        if (this.signal.aborted) {
            // Queue as a microtask: callers attach this after constructing the
            // Promise, so resolve/reject must not fire synchronously inline.
            void Promise.resolve().then(fire);
            return;
        }
        this.signal.addEventListener('abort', fire, { once: true });
    }
    approval = {
        request: (req) => new Promise((resolve, reject) => {
            this.pendingApproval = {
                req,
                resolve: (d) => {
                    this.pendingApproval = null;
                    this.notify();
                    resolve(d);
                },
            };
            this.notify();
            this.onInterrupt(reject, () => {
                this.pendingApproval = null;
            });
        }),
    };
    convergence = {
        select: (req) => new Promise((resolve, reject) => {
            this.pendingConvergence = {
                req,
                resolve: (selected) => {
                    this.pendingConvergence = null;
                    this.notify();
                    resolve(selected);
                },
            };
            this.notify();
            this.onInterrupt(reject, () => {
                this.pendingConvergence = null;
            });
        }),
    };
    testCommands = {
        request: (req) => new Promise((resolve, reject) => {
            this.pendingTestCommands = {
                req,
                proposals: [],
                discovering: false,
                discoverError: null,
                resolve: (commands) => {
                    this.pendingTestCommands = null;
                    this.notify();
                    resolve(commands);
                },
            };
            this.notify();
            this.onInterrupt(reject, () => {
                this.pendingTestCommands = null;
            });
        }),
    };
    /**
     * Runs the request's agent discovery and folds the proposals into the
     * pending request, so the panel can offer them alongside what the offline
     * heuristics found. Called by the App, which owns the decision to spend a
     * session on it; failures surface as `discoverError` rather than throwing
     * into a keypress handler.
     */
    async discoverTestCommands() {
        const pending = this.pendingTestCommands;
        if (!pending || pending.discovering)
            return;
        pending.discovering = true;
        pending.discoverError = null;
        this.notify();
        try {
            pending.proposals = await pending.req.discover();
        }
        catch (err) {
            pending.discoverError = err instanceof Error ? err.message : String(err);
        }
        finally {
            pending.discovering = false;
            this.notify();
        }
    }
    discuss = {
        begin: (nodeId, topic, seedTranscript = []) => {
            this.discussState = {
                nodeId,
                topic,
                transcript: [...seedTranscript],
                awaitingUser: false,
                active: true,
            };
            this.notify();
        },
        postAssistant: (nodeId, text) => {
            if (this.discussState?.nodeId === nodeId) {
                this.discussState = {
                    ...this.discussState,
                    transcript: [...this.discussState.transcript, { role: 'assistant', text }],
                };
                this.notify();
            }
        },
        nextUserMessage: (nodeId) => new Promise((resolve, reject) => {
            if (this.discussState?.nodeId === nodeId) {
                this.discussState = { ...this.discussState, awaitingUser: true };
            }
            this.nextMessageResolve = resolve;
            this.notify();
            this.onInterrupt(reject, () => {
                this.nextMessageResolve = null;
            });
        }),
        end: (nodeId) => {
            if (this.discussState?.nodeId === nodeId) {
                this.discussState = { ...this.discussState, active: false, awaitingUser: false };
                this.notify();
            }
        },
    };
    /** Called by the App when the user submits a discussion message (null = done). */
    submitUserMessage(text) {
        const resolve = this.nextMessageResolve;
        if (!resolve)
            return;
        this.nextMessageResolve = null;
        if (this.discussState) {
            this.discussState = {
                ...this.discussState,
                awaitingUser: false,
                transcript: text === null
                    ? this.discussState.transcript
                    : [...this.discussState.transcript, { role: 'user', text }],
            };
        }
        this.notify();
        resolve(text);
    }
}
//# sourceMappingURL=ports.js.map