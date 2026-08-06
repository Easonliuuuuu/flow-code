## Why

Subagents are denied today (`Task`/`Agent` in `ALWAYS_DENIED_TOOLS`) on the grounds that "subagent tool calls would put tool calls outside the interception point" — see the `node-skills` design note. That is no longer true of the SDK we run: `BaseHookInput` now carries `agent_id`, documented as "present only when the hook fires from within a subagent (e.g., a tool called by an AgentTool worker)". The PreToolUse hook that `intercept.ts` is wired to fires for subagent tool calls, with attribution.

So the reason for the ban has expired, while the cost of the ban has not: an agent that could delegate a wide search or a set of independent sub-tasks has to do it serially in its own context instead. Meanwhile flow-code's own fan-out primitive (Worktree-Agent instances) already produces several concurrent sessions per node, and the UI cannot tell them apart either — `instanceId` is recorded on every activity entry and read by nothing. Lifting the ban and giving the run-state and UI a notion of "who, inside this node, did this" are the same piece of work.

## What Changes

- Node agent sessions MAY spawn subagents. `Task`/`Agent` leave the always-denied set; the default-deny fallthrough in `intercept.ts` still refuses every tool it does not recognize.
- A subagent inherits its parent node's capability set and working directory, enforced by the same interceptor. No node type gains a capability, and a subagent can never exceed its parent. This is what makes the change safe without a per-node-type policy: the limit is the capability set that already exists.
- Subagents are drawn from a closed registry supplied by flow-code via the SDK's `agents` option, so the set of spawnable agent types is declared rather than model-chosen.
- Activity-log entries gain agent attribution (`agentId`, `agentType`), threaded from hook input through the interceptor. The existing `instanceId` becomes readable in the same place.
- The node detail view groups its activity log by originating agent instead of interleaving concurrent agents into one flat chronological list. The node card shows a subagent count while running.
- The canvas stays flat — one box per workflow node, no subagent boxes. See design.md for why.
- Subagent sessions count against the run's concurrency cap, which today governs only node-level sessions.
- **BREAKING** for run-state readers: `ActivityEntry` gains optional fields. Older run files remain readable (all additions optional), but entries written before this change carry no attribution and render as the parent agent.

## Capabilities

### New Capabilities
- `node-subagents`: when a node's agent session may delegate to subagents, what bounds those subagents, how their work is attributed in run-state, and how the run's concurrency cap accounts for them.

### Modified Capabilities
- `agent-execution`: the "Capability harness enforces node permissions" requirement gains subagent tool calls as an explicitly covered case; "Tool-call activity log" gains the attribution fields; "Concurrency cap for parallel sessions" must count subagent sessions, not only node and Worktree-Agent-instance sessions.
- `node-skills`: the "Skills cannot grant network or subagent access" scenario is now half wrong — network stays unavailable, subagents no longer do. The requirement it sits under ("Skills never widen a node's capability envelope") still holds and is in fact the same argument this change relies on, so the scenario narrows to network rather than being deleted.
- `terminal-canvas-ui`: the "Node detail view" requirement gains per-agent attribution in the activity log, covering Worktree-Agent instances as well as subagents.

## Impact

Code:
- `src/harness/compile.ts` — `ALWAYS_DENIED_TOOLS`, and a compiled subagent registry alongside the tool policy.
- `src/harness/intercept.ts` — `check`/`promptCheck` accept and record agent attribution; the deny path for `Task`/`Agent` goes away.
- `src/executors/sdkRunner.ts` — pass `agents` in `Options`; forward `agent_id`/`agent_type` from hook input; guard `assistantText` against subagent text reaching `finalText`.
- `src/runstate/types.ts`, `src/runstate/store.ts` — attribution fields on `ActivityEntry`.
- `src/engine/engine.ts` — concurrency accounting for subagent sessions.
- `src/ui/App.tsx`, `src/ui/nodeCard.ts` — grouped activity rendering, subagent count on the card.

Not affected, and deliberately so: the Codex, OpenAI-compat and NVIDIA runners have no subagent concept, so this is a Claude-SDK-only capability. design.md covers what that asymmetry means for the "enforcement is equivalent across runners" guarantee in `agent-execution`.

Dependencies: no new packages. Relies on `@anthropic-ai/claude-agent-sdk` ≥ 0.3.220 for `BaseHookInput.agent_id`.
