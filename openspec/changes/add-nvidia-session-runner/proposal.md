## Why

Every agent-driven node (Discuss, Implement, Validate, Review, Git-ops, Worktree-Agent) currently runs through a single hardcoded `SdkSessionRunner`, which drives the `@anthropic-ai/claude-agent-sdk` and therefore requires Claude credentials to run at all. Testing flow-code end-to-end has no path that avoids Anthropic, even for someone who already has a working, free-tier NVIDIA NIM API key and just wants to exercise the workflow graph. This change adds a second `SessionRunner` backed by NVIDIA's OpenAI-compatible NIM API, and routes non-Discuss agent nodes to it, so a run can execute Implement/Validate/Review/Git-ops entirely on a free NVIDIA key. Discuss stays on the Claude Agent SDK in this change — it's a smaller, interactive surface, and it's free for anyone already logged into Claude Code, so there's no pressing need to port it yet.

## What Changes

- Add `NvidiaSessionRunner`, a new `SessionRunner` implementation (`src/engine/types.ts`'s existing interface) that talks to NVIDIA's NIM chat-completions API (OpenAI-compatible, base URL `https://integrate.api.nvidia.com/v1`) instead of the Claude Agent SDK.
- Since NVIDIA's API has no built-in tools and no permission-hook system (unlike the Claude Agent SDK), `NvidiaSessionRunner` implements its own minimal tool-calling loop (read/list/grep/write/shell-style tools offered via OpenAI function-calling) and its own capability-enforcement layer, structurally equivalent to the existing three-layer design (tools not offered when the capability forbids them, a per-call check before execution, a stated boundary in the system prompt) but implemented independently of `src/harness/compile.ts` / `src/harness/intercept.ts`, which are wired to literal Claude Agent SDK tool names and hook shapes.
- `NvidiaSessionRunner` implements `run()` only. `openInteractive()` is not implemented for this runner in this change (throws if called) — Discuss is routed away from it, so this is never exercised in practice.
- Add a `CompositeSessionRunner` that routes the `discuss` node type to the existing `SdkSessionRunner` and every other agent-driven node type to `NvidiaSessionRunner`, and wire it in as the `sessions` runner constructed in `cli.ts`.
- Add an `NVIDIA_API_KEY` environment-variable credential check to `preflight.ts`: required whenever the loaded workflow contains any node type that will route to `NvidiaSessionRunner` (i.e. any agent-driven node type other than `discuss`; `test` never opens a session at all). The existing Claude-credential check is unchanged and still required whenever a `discuss` node is present. Both checks fail before any node starts, per the existing preflight contract.
- New default model for NVIDIA-routed nodes: `meta/llama-3.3-70b-instruct`. The existing per-node `config.model` override continues to work, now selecting an NVIDIA model id instead of a Claude one for NVIDIA-routed node types.
- No change to node type schemas, workflow YAML shape, the engine's DAG execution, run-state, or the UI — this is entirely behind the `SessionRunner` boundary.

## Capabilities

### New Capabilities
(none — this extends the existing execution capability rather than introducing a new one)

### Modified Capabilities
- `agent-execution`: node execution is no longer exclusively "drive a Claude Agent SDK session" — it becomes provider-routed (Claude for Discuss, NVIDIA for other agent-driven node types), preflight gains an NVIDIA-credential check conditioned on which node types are present, and the capability-harness requirement must be restated so it holds regardless of which runner executes a node.

## Impact

- **New files**: an NVIDIA session runner module and its own tool-calling/enforcement loop (naming and file layout decided in design.md).
- **Modified**: `src/cli.ts` (construct and wire `CompositeSessionRunner` instead of `SdkSessionRunner` directly), `src/engine/preflight.ts` (new NVIDIA-credential check, new failure kind).
- **Unmodified but load-bearing**: `src/engine/types.ts` (`SessionRunner` interface — no changes needed, it's already runner-agnostic), `src/capabilities.ts` (`Capability`/`CapabilitySet` — reused as-is), `src/harness/gitCommands.ts` (`classifyCommand` — reused as-is for the new runner's shell-tool checks).
- **Explicitly not modified**: `src/harness/compile.ts`, `src/harness/intercept.ts` (Claude-SDK-specific; the new runner does not route through them).
- **Out of scope for this change**: Discuss on NVIDIA, Worktree-Agent instances on NVIDIA (flagged as an open question in design.md rather than decided here), token-level streaming parity with the Claude SDK's live output (buffering per tool-call round is acceptable for v1).
