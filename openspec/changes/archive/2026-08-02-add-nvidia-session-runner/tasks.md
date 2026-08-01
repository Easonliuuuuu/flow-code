## 1. Shared prerequisites

- [x] 1.1 Export `outsideWorkingDir` from `src/harness/intercept.ts` (or move it to a shared location) so the new NVIDIA-side checker reuses it instead of duplicating path-containment logic
- [x] 1.2 Confirm `classifyCommand` (`src/harness/gitCommands.ts`) is already exported and usable as-is for classifying `run_shell` calls (git-read / git-write / non-git)
- [x] 1.3 Add `NVIDIA_API_KEY` to `.env`/README env-var documentation alongside the existing `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` mentions

## 2. Preflight

- [x] 2.1 Add `'nvidia-credentials'` to `PreflightFailureKind` in `src/engine/preflight.ts`
- [x] 2.2 Add a helper that determines whether a workflow requires the NVIDIA runner (any node type other than `discuss`/`test` that opens an agent session)
- [x] 2.3 In `preflight()`, when the workflow requires the NVIDIA runner and `process.env['NVIDIA_API_KEY']` is unset, throw `PreflightError('nvidia-credentials', ...)` naming `NVIDIA_API_KEY` explicitly, before any node starts
- [x] 2.4 Tests: workflow with only Discuss + Test does not require `NVIDIA_API_KEY`; workflow with an Implement node and no `NVIDIA_API_KEY` fails preflight with the right `kind` and message; existing Claude-credential preflight behavior is unchanged

## 3. NVIDIA tool-calling loop

- [x] 3.1 Define the OpenAI-style tool schemas: `read_file`, `list_dir`/`glob`, `grep`, `write_file`, `run_shell` — one module, independent of `src/harness/compile.ts`
- [x] 3.2 Implement capability-to-offered-tools mapping (only offer `read_file`/`list_dir`/`grep` when `read` is granted, `write_file` when `edit` is granted, `run_shell` when `exec`/`git-read`/`git-write` is granted) — mirrors `compile.ts`'s `READ_TOOLS`/`EDIT_TOOLS`/`EXEC_TOOLS` grouping
- [x] 3.3 Build the system-prompt boundary paragraph for a capability set (equivalent intent to `compile.ts`'s `boundaryPrompt`, reworded for a model with no built-in tools)
- [x] 3.4 Implement the NVIDIA-side per-call checker (new module): path containment via 1.1's exported helper, git command classification via `classifyCommand`, capability checks — returns the same `PermissionDecision` shape `intercept.ts` uses
- [x] 3.5 Wire the checker's outcome (allowed/denied, including `missingCapability` on denial) into `store.appendActivity()` using the existing `ActivityEntry` type, matching the fields `intercept.ts` populates today
- [x] 3.6 Implement the actual tool executors (read a file scoped to `workingDir`, list/glob, grep, write a file, run a shell command) that only run after the checker allows the call
- [x] 3.7 Implement the main loop: system prompt + capability-scoped tools → NVIDIA chat-completions call → execute any tool calls (checked per 3.4) → append tool results → repeat until a text-only response or the iteration cap (40) is hit
- [x] 3.8 On hitting the iteration cap, fail the node with a clear error message rather than looping silently
- [x] 3.9 Wire `onText` to fire with the assistant's text per completed turn (not per token — see design.md's streaming-granularity non-goal)
- [x] 3.10 Apply the same env-scoped `remote.origin.pushurl` block (`compile.ts`'s existing `env` output) to the child process for non-Git-ops NVIDIA-routed nodes

## 4. NvidiaSessionRunner

- [x] 4.1 Implement `NvidiaSessionRunner` (new file) satisfying the `SessionRunner` interface from `src/engine/types.ts`
- [x] 4.2 Implement `run()`: builds the request from `AgentSessionRequest`, resolves the model via `req.model` → run default → `meta/llama-3.1-70b-instruct` (verified live; `3.3` hangs on this account/tier — see design.md), drives the loop from section 3, returns `{ finalText }`
- [x] 4.3 Implement `openInteractive()` to throw `Error('NvidiaSessionRunner does not support interactive sessions')` — never expected to be called given routing, but keeps the contract explicit rather than silently misbehaving
- [x] 4.4 Tests: capability enforcement parity — for a representative set of scenarios already covered for the Claude path (edit-capability denial, git-write denial, working-directory escape denial, network tools never offered), assert the same allow/deny outcome and the same `ActivityEntry` shape

## 5. Routing

- [x] 5.1 Implement `CompositeSessionRunner` (new file) satisfying `SessionRunner`: `run()`/`openInteractive()` inspect `req.nodeId`'s node type via the workflow and dispatch to `SdkSessionRunner` for `discuss`, `NvidiaSessionRunner` for every other agent-driven node type
- [x] 5.2 Update `src/cli.ts` to construct `CompositeSessionRunner` (wrapping both underlying runners) instead of `new SdkSessionRunner()` directly
- [x] 5.3 Tests: a Discuss node's session is driven by `SdkSessionRunner`; an Implement node's session is driven by `NvidiaSessionRunner`; verify via a fake/mock pair of runners injected into `CompositeSessionRunner`

## 6. End-to-end verification

- [x] 6.1 Manual run: workflow with Discuss (Claude) → Implement/Test/Validate/Review/Git-ops (NVIDIA) against a real `NVIDIA_API_KEY`, confirm the graph completes and the Approval-Gate diff is correct
- [x] 6.2 Confirm activity log and "N blocked actions" indicator render identically in the terminal UI regardless of which runner executed a node
- [x] 6.3 `npm run typecheck && npm run lint && npm test` all green
