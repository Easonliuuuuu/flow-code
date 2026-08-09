## Context

`Engine` (`src/engine/engine.ts`) already takes its UI dependency as data, not as a hardwired terminal: `EngineOptions.ports: InteractionPorts` is documented in `src/engine/types.ts` as "UI bridge for the interactions a run can require. Headless-substitutable." The approval gate calls `ctx.ports.approval.request(...)` and awaits a promise (`src/executors/gate.ts`); Discuss calls `ports.discuss.nextUserMessage(nodeId)` and awaits the next string. Today exactly one implementation of `InteractionPorts` exists, wired to the terminal canvas. This design adds a second implementation wired to MCP tool calls — the engine does not know or care which one is driving it.

Run state is the other seam this design leans on. `RunStateStore` (`src/runstate/store.ts`) is an in-memory store with a `StoreListener` subscription (`export type StoreListener = (state: RunState) => void`) that the engine mutates as nodes transition, plus a `StorePersister` that flushes to `.flow-code/runs/<runId>.json`. `RunStateWatcher` (`src/runstate/watch.ts`) is the file-polling reader `flow-code watch` uses to render a run from a *different* process. The MCP server sits in neither role exclusively: for a run it started itself, it holds the live `RunStateStore` in the same process and can subscribe directly; for a run started elsewhere (a previous MCP session, or `flow-code run` from a terminal), it has no live store and must fall back to the same file-watching path `watch` uses.

`add-guest-mode-reporter`'s design document already settled the adjacent question — how a second *producer* of run-state coexists with the engine — and answered it with ownership checks because guest mode has no engine and must invent a writer. This design has no analogous problem: there is exactly one producer (the engine), and the MCP server is a second *consumer/controller*, not a second writer. That asymmetry is why this change is lower-risk than guest mode, and why it is not blocked on `RunStateStore`'s ownership work the way guest mode is — though it still can't ship before M2, since a driver-mode bug now has two ways to be triggered instead of one, and M2 is exactly the milestone for making driver mode hold up under that.

## Goals / Non-Goals

**Goals:**
- Let a run be started, observed, and gated entirely through MCP tool calls, with the engine, harness, and executors unmodified.
- Implement the new entry point as an `InteractionPorts` implementation plus a thin lifecycle wrapper around `Engine`, not as a parallel execution path.
- Give a calling model enough structure in `get_run_state` (node statuses, graph edges, current node, last transition and why) to narrate the run intelligibly without the canvas.
- Avoid polling: push node-transition and completion events as MCP progress notifications for the process that owns the live run.
- Keep a run started via MCP fully interoperable with the CLI — inspectable by `flow-code watch`, resumable by `flow-code run --resume` — since both read the same run-state file.

**Non-Goals:**
- Reproducing the terminal canvas over MCP, in any form (ASCII, structured widget, etc.). Explicitly accepted as lost for this surface.
- Any change to `src/engine/`, `src/harness/`, or `src/executors/` beyond a new `InteractionPorts` implementation. If a requirement can't be met without touching those, it's out of scope for this change.
- Parallel or fan-out run control (starting two runs from one MCP session). One server process drives at most one live run at a time, matching how `flow-code run` behaves today.
- Solving which provider a node uses when driven from MCP. Flagged as an open question below, not decided here.

## Decisions

**A new `McpInteractionPorts` class implements `InteractionPorts`, nothing else changes engine-side.** `approval.request` resolves when `respond_to_gate` is called with matching `nodeId`; `discuss.nextUserMessage` resolves on the next Discuss-directed tool call; `testCommands.request` and `convergence.select` get equivalent tool-backed implementations for parity, since a run started over MCP can still hit a Test node's first-run discovery or a Worktree-Agent convergence. *Alternative considered:* have the MCP server shell out to `flow-code run` as a subprocess and scrape its output. Rejected — it reintroduces a text-parsing layer over something that already has a typed interface built for exactly this substitution.

**`start_run` is a long-running tool call, not fire-and-forget.** It stays open for the run's duration, emitting MCP progress notifications on each `RunState` change (subscribed directly via `RunStateStore`'s listener, in-process — no polling). It resolves when the run reaches a terminal state (done, error, or stopped) or is aborted. *Alternative considered:* `start_run` returns immediately with a run id, and the host polls `get_run_state`. Rejected as the default because polling is exactly what progress notifications exist to avoid and because Discuss/gate turns need a call already in flight to resume — but `get_run_state` still exists standalone, for a host that reattaches to a run this server process didn't start.

**`get_run_state` serves both a live and a cold run.** If the calling server process holds the run's live `RunStateStore`, it reads that directly. Otherwise it falls back to `latestRunState`/`RunStateWatcher` exactly as `flow-code watch` does, so a host can ask about a run it didn't start (e.g., one left running from a terminal). *Alternative considered:* MCP-driven runs only ever visible to the session that started them. Rejected — it would make the MCP surface strictly weaker than `flow-code watch` for no reason, since the file already carries everything needed.

**Graph shape is included in `get_run_state`, not just current status.** The response carries the workflow's node list, edges (including loop-back edges), current per-node status, and the reason for the most recent transition (e.g., "test: failed, looped back to implement"). Without this a calling model sees status flicker with no causal story. *Alternative considered:* status-only response, graph shape fetched once via a separate `get_workflow` tool. Rejected for the common case — most callers want both together on every check — but worth revisiting if the combined payload turns out to be large on bigger graphs (see BR-05's stated concern about navigability at scale).

**Discuss and Gate resume through the same tool, `respond`, disambiguated by node id and kind.** Rather than one tool per interaction type, a single `respond_to_gate`-shaped tool takes `{ nodeId, kind: 'gate' | 'discuss', payload }`, because both are "the host answers a question the run is blocked on" and a model reasons about them more reliably as one recurring affordance than as an ad hoc set of node-type-specific tools. *Alternative considered:* separate `respond_to_gate` / `respond_to_discuss` tools. Kept as an open question below rather than settled — there's a real readability argument either way and it should be decided against actual tool-call transcripts, not in the abstract.

**Provider selection is unchanged by default: every node still spawns its own configured provider session.** This design does not make the calling session double as a node's provider. That is flagged as a real question (below) but deliberately deferred, because "reuse the calling session as a provider" is a materially different and riskier design — it would mean a node's execution is no longer independent of what's driving the run, which cuts against the harness's own boundary model. Shipping the boring version first (nodes stay independent) keeps this change's blast radius to the entry point only.

## Risks / Trade-offs

- **A long-running `start_run` tool call ties up the host's tool-call budget/turn for the run's duration** → Acceptable for now since Discuss and Gate already require the run to hold a turn open; revisit if hosts start timing out long test/implement steps.
- **Two state-read paths (live subscription vs. file watcher) is more code than one** → Necessary because MCP driving and terminal driving must stay interoperable (a goal both this change and `add-guest-mode-reporter` share); the fallback path is exactly `flow-code watch`'s existing logic, not new logic.
- **A model narrating `get_run_state` badly (wrong causal story, hallucinated node names) misrepresents the run** → Mitigated by returning the graph shape and transition reason as structured data rather than prose, so misrepresentation is a model error visible against the ground truth in the payload, not a gap the server papered over.
- **This change and `add-guest-mode-reporter` could be built by someone assuming they're the same problem** → Addressed explicitly in `proposal.md`'s Impact section; both should stay cross-referenced so a future reader doesn't merge or reject one on the other's reasoning.
- **MCP SDK is a second protocol dependency** (guest mode already takes one) → Confine to `src/mcp/`, matching guest mode's stated approach of keeping the SDK at the boundary.

## Migration Plan

Purely additive: a new `flow-code mcp` subcommand and a new `src/mcp/` module. `flow-code run`, `flow-code watch`, and the run-state file format are untouched. Rollback is deleting the new surface; no run started by the CLI depends on anything this change adds, and no run started via MCP is unreadable by the CLI afterward, since both write the identical `RunState` document.

## Open Questions

- Single `respond` tool disambiguated by kind, or separate `respond_to_gate`/`respond_to_discuss` tools? Decide from real transcripts once a prototype exists, not speculatively.
- Should an MCP-driven run let specific node types (not all) default to using the calling session as their provider, to avoid a Claude/Codex session unknowingly spawning a nested session of itself for, e.g., an Implement node? If yes, this is a second design, not an extension of this one — it changes `SessionRunner` selection, which this change deliberately keeps out of scope.
- Does `get_run_state`'s combined graph-shape-plus-status payload need pagination or a summarized form once graphs are large (BR-05 territory), or is that premature until a graph that size is actually driven over MCP?
- Does progress-notification granularity need to be configurable (every status change vs. only terminal per-node transitions), or is one fixed granularity enough for the hosts this targets (Claude Code, Codex CLI)?
