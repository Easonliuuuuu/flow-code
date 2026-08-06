## 1. Resolve the token-reporting unknown

- [x] 1.1 Run a throwaway SDK session that spawns a subagent, with the spawn tool temporarily permitted, and record which messages carry `usage` and whether any of it originates from the subagent
- [x] 1.2 Write down the finding in design.md's Open Questions — either subagent usage reaches `reportUsage`, or per-node token counts under-report and the header rate-limit meter is the only honest cost signal
- [x] 1.3 If usage is lost, decide and record whether to forward subagent messages for accounting or to accept the gap; do not change UI behavior in this group

## 2. Attribution in run-state and the harness

Lands with subagents still denied — it fixes Worktree-Agent instance attribution, which is broken today, and is independently shippable.

- [x] 2.1 Add optional `agentId` and `agentType` to `ActivityEntry` in `src/runstate/types.ts`, documenting that absent means the node's own session
- [x] 2.2 Extend `Interceptor.check` and `Interceptor.promptCheck` opts with `agentId`/`agentType`, and record them in `intercept.ts`'s `record()` alongside `instanceId`
- [x] 2.3 Forward `agent_id`/`agent_type` from `PreToolUseHookInput` into `interceptor.check` in `src/executors/sdkRunner.ts`
- [x] 2.4 Add the same fields to `nvidiaIntercept.ts`'s entry shape so both interceptors write entries of one shape — no change needed: it already writes a correctly-shaped `ActivityEntry`, and omitting the fields is exactly right there (absent means the node's own session, and those runners have no subagents)
- [x] 2.5 Test: an entry recorded with an agent id round-trips through the store and the persisted run file; an entry recorded without one reads back as the parent's
- [x] 2.6 Test: a run-state file written before this change still parses and its entries read as the parent's

## 3. Activity-log attribution in the UI

- [x] 3.1 Extend `nodePanelActivity` in `src/ui/App.tsx` to derive, per node, how many distinct agents produced its entries (counting `instanceId` and `agentId` alike)
- [x] 3.2 Add an attribution column to `formatActivityRow`, rendered only when a node's entries came from more than one agent, so single-agent nodes spend no width on it
- [x] 3.3 Test: a node with entries from two Worktree-Agent instances renders both distinguishably
- [x] 3.4 Test: a node whose entries all came from its own session renders no attribution column
- [x] 3.5 Verify the panel stays within its width budget at the narrowest supported terminal — covered by an automated 80-column render test rather than a hand check, so the constraint stays enforced

## 4. The subagent registry

- [x] 4.1 Add a `compileSubagents(caps, workingDir)` to `src/harness/compile.ts` returning the `AgentDefinition` registry for a node, with each definition's `tools` at or below the node's capability set, and each carrying its own `permissionMode` — a subagent does not inherit the parent's (design finding 2)
- [x] 4.2 Remove `Task` and `Agent` from `ALWAYS_DENIED_TOOLS`, leaving the network tools; update the denial message in `intercept.ts`, which currently names subagents
- [x] 4.3 Add a spawn-tool input check to `intercept.ts`'s `decide()`: a `subagent_type` outside the compiled registry is denied, in the same shape as the existing control-artifact check. Key it on both `Agent` and `Task` — the live SDK sends `Agent`, and the name has moved once already
- [x] 4.4 Pass `agents` in `buildOptions` in `src/executors/sdkRunner.ts`
- [x] 4.5 Test: a spawn call naming a registry type is allowed; one naming an unknown type is denied and logged, under both tool names
- [x] 4.6 Test: an unrecognized tool name is still denied by the default-deny fallthrough, so lifting the ban did not widen the tool surface

## 5. Capability inheritance

- [x] 5.1 Test: a subagent tool call carrying an `agent_id` is checked against the parent node's capability set — a write under a `read`-only node type is denied
- [x] 5.2 Test: a subagent file path resolving outside the parent's working directory is denied
- [x] 5.3 Test: a subagent denial increments the parent node's `denials` count and leaves the node's status unchanged
- [x] 5.4 Test: a subagent under a Worktree-Agent instance is scoped to that instance's worktree, not the repo root

## 6. Concurrency accounting

- [x] 6.1 Add a run-wide subagent counter to `src/engine/engine.ts`, exposed to the interceptor, incremented when a spawn call is allowed and decremented on subagent completion
- [x] 6.2 Deny the spawn tool in `intercept.ts` when no allowance remains, with a message naming the cap and telling the session to proceed itself
- [x] 6.3 Wire `SubagentStart`/`SubagentStop` hooks in `sdkRunner.ts` to reconcile the counter against actual subagent lifetime — both fire reliably and carry `agent_id` (verified in task 1.1)
- [x] 6.4 Test: with the cap exhausted, a spawn call is denied and returns immediately rather than blocking
- [x] 6.5 Test: allowance is released on subagent completion and a later spawn within the cap succeeds
- [x] 6.6 Test: a parent holding a slot whose spawn is refused continues to completion — the deadlock the design rules out

## 7. Output integrity

Not defensive: task 1.1 observed subagent `text` blocks on the stream with `forwardSubagentText` unset, so `finalText` is genuinely reachable by subagent prose.

- [x] 7.1 Filter assistant messages with a non-null `parent_tool_use_id` out of `assistantText` in `src/executors/sdkRunner.ts`
- [x] 7.2 Test: subagent text on the stream does not become `finalText`, including with `forwardSubagentText` on
- [x] 7.3 Test: a Validate node's JSON verdict survives interleaved subagent text

## 8. Card indicator

- [x] 8.1 Track in-flight subagent count per node in the store, so the card can read it without the UI observing the SDK
- [x] 8.2 Render the count on the node card in `src/ui/nodeCard.ts`, dropped first when the card is too small for it
- [x] 8.3 Test: a node with subagents in flight shows the count; a `mini` card omits it rather than displacing status or identity
- [x] 8.4 Test: the canvas renders one box per workflow node regardless of subagent count

## 9. Rollout control

- [x] 9.1 Add `settings.subagents` to the workflow schema in `src/workflow/schema.ts`, defaulting to enabled
- [x] 9.2 Honor it in `compileSubagents` — disabled yields an empty registry, so every `Task` call is denied by the registry check with no special case
- [x] 9.3 Test: with `settings.subagents: false`, a `Task` call is denied and the node completes normally

## 10. Documentation

- [x] 10.1 Add a superseded-note pointer to the `node-skills` archived design rather than rewriting it — the archive is a record of what was decided and why, and it was correct when written
- [x] 10.2 Regenerate node-type docs (`npm run docs:node-types`) — output unchanged, since no node type's capability set moved; documented `settings.subagents` in the README instead
- [x] 10.3 Run `npm run typecheck`, `npm run lint`, and `npm test`; confirm the full suite passes before archiving
