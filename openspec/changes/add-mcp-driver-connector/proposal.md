## Why

Using flow-code today means opening a second terminal and running `flow-code run` beside whatever agent CLI (`claude`, `codex`) the user was already in. `add-guest-mode-reporter` closes that gap by letting a foreign agent self-report into run-state, but pays for it by dropping the harness entirely — no capability enforcement, no token accounting, no real test verdicts. That is the right shape for a user who never runs flow-code's engine at all, but it is not the only way to stop asking people to leave their session: `flow-code watch` proved the graph doesn't need to own execution, and by the same logic, execution doesn't need to own the terminal. The engine can run exactly as it does today and simply be reachable as an MCP tool from inside the session the user is already in.

**This proposal is deliberately not scheduled**, for the same reason `add-guest-mode-reporter` is parked: M3 depends on M2 (driver mode being trustworthy under real conditions) per `docs/product/roadmap.md`, and this change adds a second entry point into the same engine before that foundation is settled. It is captured now because the design — and its relationship to the guest-mode alternative — is clear while the reasoning is fresh.

## What Changes

- **New MCP server** (`flow-code mcp`, stdio transport) exposing driver-mode lifecycle as tools: `start_run`, `get_run_state`, `respond_to_gate` (also resumes a waiting Discuss node), `stop_run`. Each wraps an existing module — `start_run` drives the same `Engine` construction `src/cli/run.ts` performs, `get_run_state` reads through `RunStateWatcher`/`latestRunState` (`src/runstate/watch.ts`), `respond_to_gate` writes the same approval `flow-code run`'s keyboard handler writes today.
- **No engine or harness changes.** `src/harness` and `src/executors` already run independent of `src/ui`; the same capability-scoped tool policy, command interception, and git-write gating apply to a run regardless of whether the CLI or an MCP tool call started it.
- **Approval-gate gains an MCP approval path.** A gate can be approved or rejected via the `respond_to_gate` tool, not only the keyboard, while a run is being driven from an MCP host — a spec-level addition to how a gate may be answered, not a new mechanism for what a gate blocks.
- **No graph visualization over MCP** — deliberately out of scope. `get_run_state` returns per-node status plus enough graph shape (edges, current node, last transition and its reason) for a calling model to narrate a loop-back correctly, but no attempt is made to reproduce the terminal canvas.
- **Progress notifications during `start_run`.** Since a run is long-lived, `start_run` emits MCP progress events as nodes transition, so a host session can reflect state without polling `get_run_state` in a loop.
- **Discuss becomes a multi-turn tool exchange.** Instead of a REPL, the server reports "waiting on discuss" with its question; the host session's reply resumes it via the same tool call pattern as a gate response.

## Capabilities

### New Capabilities
- `mcp-driver-connector`: the `flow-code mcp` server — its tools, run lifecycle over MCP (start/status/respond/stop), progress notifications, and how it reuses the existing engine and run-state store without becoming a second implementation of either.

### Modified Capabilities
- `approval-gate`: gains a requirement that a gate may be approved or rejected via the MCP surface when a run is MCP-driven, in addition to the existing keyboard path, with identical blocking semantics either way.

## Impact

- **`src/cli/`**: new `mcp` subcommand alongside `run`/`init`/`watch`; no changes to existing subcommands.
- **New dependency**: an MCP SDK, confined to a new `src/mcp/` boundary module.
- **`src/runstate/`**: read-only consumer via the existing watcher; no changes to `RunStateStore` or the persisted file format. Unlike `add-guest-mode-reporter`, this change introduces no second writer and no ownership-conflict surface — the MCP server drives the one engine process, it doesn't compete with it.
- **`src/engine/`, `src/harness/`, `src/executors/`**: untouched. The proposal's core claim is that nothing here needs to change for the harness's guarantees to hold over the new entry point.
- **Relationship to `add-guest-mode-reporter`**: both changes target BR-06 and both remove the "open a second terminal" cost, but they make opposite bets on the same tradeoff — guest mode drops the harness to support any foreign agent with zero new session runner; this change keeps the harness but only works for runs flow-code itself executes. They are complements, not alternatives: guest mode is for agents flow-code doesn't run, this is for when it does. Neither supersedes the other, and `design.md` should not be read as arguing guest mode should be dropped.
- **Open design question carried into `design.md`, not resolved here**: whether an MCP-driven run should default some nodes to "use the calling session as provider" versus always spawning an independent provider session, so a Claude/Codex session driving flow-code doesn't unknowingly shell out to spawn a nested session of itself.
