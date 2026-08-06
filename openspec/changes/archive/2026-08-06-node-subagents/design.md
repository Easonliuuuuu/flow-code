## Context

flow-code's capability harness is built in three layers: a compiled deny list (`compile.ts`), a per-tool-call interception check (`intercept.ts`), and a system-prompt statement of the boundary. Layer 2 is the one that actually enforces, and it is wired to the SDK's `PreToolUse` hook.

Subagents were banned when `node-skills` landed, on a specific technical claim: subagent tool calls would execute outside that hook, so the harness would stop being a boundary. That claim was true then. It is not true of `@anthropic-ai/claude-agent-sdk` 0.3.220, where `BaseHookInput` carries:

> `agent_id` — Subagent identifier. Present only when the hook fires from within a subagent (e.g., a tool called by an AgentTool worker). Absent for the main thread, even in `--agent` sessions.

A field that exists solely to tell you *which subagent* a hook fired for is only meaningful if the hook fires for subagents. So the interception point already covers them, and already distinguishes them.

This was verified against the live SDK before implementation (task 1.1). A session that spawns one subagent produces exactly this order, with the subagent's own tool call hooked and attributed:

```
PreToolUse  tool=Agent  agent_id=null       subagent_type=prober
SubagentStart          agent_id=a35e5c71…  agent_type=prober
PreToolUse  tool=Read   agent_id=a35e5c71…  agent_type=prober
SubagentStop           agent_id=a35e5c71…  agent_type=prober
```

Four things about the real behavior differ from what the type declarations alone suggest, and each shaped a decision below:

1. **The tool is named `Agent`, not `Task`.** `subagent_type` arrives in its `tool_input`. Both names stay in scope since `ALWAYS_DENIED_TOOLS` already carries both and the name has evidently moved once.
2. **A subagent does not inherit the parent session's `permissionMode`.** With it unset on the `AgentDefinition`, the subagent's `Read` was refused before its hooks ran and the parent reported a permission error. Setting `permissionMode` on each definition is required, not cosmetic.
3. **`canUseTool` is not a reliable subagent backstop.** Under `bypassPermissions` the SDK warns it is shadowed entirely; the PreToolUse hook is the path that actually sees every call. flow-code already treats the hook as layer 3 and `canUseTool` as a backstop, so this confirms the existing shape rather than changing it.
4. **Subagent assistant messages do reach the stream**, carrying `parent_tool_use_id` and their own `usage`.

The second half of the problem is unrelated to subagents and predates them: flow-code has exactly one level of resolution below a run, the node. `ActivityEntry.instanceId` has been written by the harness since Worktree-Agent landed and is read by nothing — `nodePanelActivity` filters on `nodeId` alone. A node running three concurrent instances already renders as one spinner and one interleaved log. Subagents make that worse, but they do not create it.

## Goals / Non-Goals

**Goals:**
- Let a node's agent session delegate, without any node type gaining a capability.
- Attribute every tool call to the agent that made it, covering Worktree-Agent instances as well as subagents.
- Keep the concurrency cap meaningful when sessions can nest.
- Keep the workflow graph a faithful picture of what the user authored.

**Non-Goals:**
- Subagents for the Codex, OpenAI-compat and NVIDIA runners. They have no such mechanism; hand-rolling one is a separate change.
- Subagent-level token budgets. Budgets stay per-node; a node's subagents spend the node's allowance.
- Nested subagents-of-subagents as a designed feature. The envelope holds transitively either way, so this is neither enabled nor specially blocked.
- Persisting subagent transcripts. Only activity entries are attributed; `forwardSubagentText` stays off.

## Decisions

### Allow subagents uniformly, not per node type

Rejected: gating by node type (e.g. only `discuss` and `spec`). That requires predicting what a subagent would do inside an `implement` node — information nobody has, which is exactly the objection that stalled this. Uniform allow needs no such prediction, because the limit is already written down: `ownCapabilities(ctx)` compiles the node type's declared set, `createInterceptor` closes over it, and every tool call — parent's or subagent's — is checked against it.

The practical effect is that per-type limits fall out for free. A subagent under `review` (`['read']`) cannot write a file. One under `git-ops` cannot run a non-git command. One under `implement` gets read/edit/exec and still cannot push or reach the network. Nothing new needs deciding, and no policy exists in two places to drift apart.

### The subagent registry is closed, and enforced at the `Task` call

flow-code supplies `agents: Record<string, AgentDefinition>` in `Options`. `AgentDefinition.tools` is an allowlist, so a definition can narrow a subagent below its parent's capabilities but never widen it — the interceptor is downstream of both and has the final say regardless.

Supplying `agents` does not by itself prove built-in agent types become unreachable. So the registry is enforced where everything else is enforced: the spawn tool's input names a `subagent_type`, `intercept.ts` inspects tool input before execution, and a `subagent_type` outside the compiled registry is denied there. This is the same shape as the existing `CONTROL_ARTIFACT_IN_COMMAND` check — inspect the input, refuse, log it — rather than a new mechanism.

Each definition must also carry its own `permissionMode`, because a subagent does not inherit the parent's (finding 2 above). Omitting it does not fail open — the subagent's calls were refused, not waved through — but it does make every subagent useless, which is a failure mode worth naming since nothing in the types hints at it.

### The concurrency cap refuses, it does not queue

The `Semaphore` in `engine.ts` works because executors acquire a slot *before* calling `sessions.run`. Subagents are scheduled inside the SDK process; flow-code never gets that opportunity.

Queuing them is not just hard, it is unsafe: the parent session holds a slot while awaiting its subagent, so a subagent blocked on the same semaphore waits on a slot its own parent is holding. That is a deadlock, and with the cap defaulting low it is a likely one rather than a corner case.

So the cap is applied by **denying the `Task` call** when no allowance remains, with a message telling the agent to do the work in its own session. Denial returns immediately, the parent proceeds serially, and there is no blocking wait to deadlock. It also reuses the path the agent already understands — a denied tool call it must work around — instead of introducing an invisible stall.

Accounting: a run-wide counter, incremented when a `Task` call is allowed and decremented on `SubagentStop`, with `SubagentStart` used to reconcile. Incrementing at allow-time rather than at `SubagentStart` is deliberate; see Risks.

### Attribution rides the existing entry, and covers instances too

`ActivityEntry` gains optional `agentId` and `agentType`, threaded from `PreToolUseHookInput` through the `opts` bag `check`/`promptCheck` already take for `blockedPath` and `toolUseID`. Absent means the node's own session — which makes every activity entry ever written by an earlier version correct as-is, with no migration.

`instanceId` is already on the entry and already written. It becomes *read* here rather than added, so the same UI work serves the fan-out case that is broken today.

### The canvas stays flat; hierarchy lives in the panel

Rejected: rendering subagents as boxes on the canvas. The canvas draws the workflow the user authored, and its value comes from being the same picture every run. Subagents are model-chosen and ephemeral — the same node spawns two on one run and five on the next — so promoting them to canvas citizens would make the graph non-deterministic between runs, which is the one property a node-graph view exists to provide. It also collides with `layout.ts`'s density tiers (`mini`/`compact`/full), which exist precisely because vertical space is already contested.

So: a count on the card (`⠹ implement ⑂3`), dropped first when the card is too small; real grouping in the detail panel, where scrolling and width are already solved.

### Subagent text never becomes node output

`assistantText` in `sdkRunner.ts` filters on block type but not on `parent_tool_use_id`. This was assumed harmless because `forwardSubagentText` defaults off — task 1.1 showed it is not. A probe run produced subagent assistant messages carrying `text` blocks with `parent_tool_use_id` set, on the stream, with that option unset. `assistantText` would have returned them and `finalText` would have been overwritten.

That makes this a live bug rather than a defensive measure: `validate` and `review` parse `finalText` as JSON, so a subagent's prose reaching it silently displaces a verdict — and the verdict is what `failsWhen` routes on. The filter is mandatory, and it is also why turning `forwardSubagentText` on to close the token-accounting gap is the wrong trade.

### Rollout is a setting, not a revert

`settings.subagents` in the workflow file, defaulting to enabled. The lever exists so that turning delegation off on a misbehaving workflow is a one-line edit rather than a downgrade, and so the blast radius of this change can be narrowed without touching the harness.

## Risks / Trade-offs

**Cap overshoot under a burst** → Several `Task` calls can pass `PreToolUse` before any `SubagentStart` fires, briefly exceeding the cap. Mitigated by incrementing the counter at allow-time rather than at `SubagentStart`, which makes the check self-consistent; `SubagentStart`/`SubagentStop` then reconcile drift. Residual overshoot is bounded by the number of `Task` calls in one assistant turn.

**Per-node token counts may under-report** → Resolved in part by task 1.1. Subagent assistant messages *do* reach the stream with their own `usage`, and `reportUsage` does not filter on `parent_tool_use_id`, so subagent tool-calling turns are already counted today. What is not guaranteed is the subagent's *final text* turn: with `forwardSubagentText` off the SDK documents that only `tool_use`/`tool_result` blocks are forwarded, so a subagent's concluding turn may carry usage that never arrives. The residual under-count is therefore bounded — one turn per subagent, not the whole subagent. Accepted rather than fixed by turning `forwardSubagentText` on, since that would trade a bounded accounting gap for an unbounded output-integrity problem (see below). The header rate-limit meter remains the signal that cannot be under-counted.

**Delegation multiplies spend** → A node that fans out into subagents costs more than one that does not, and the model decides. Mitigated by the per-node token budget, which already aborts the node via its abort controller and counts every session under that node; and by the rate-limit meter making plan burn visible mid-run.

**Attribution depends on a field the SDK could stop sending** → If `agent_id` ever went absent, subagent entries would silently merge into the parent's rather than failing loudly. Mitigated by a test asserting attribution on a session that actually spawns a subagent, so the regression surfaces as a red test rather than as a quietly wrong log.

**A new surface for prompt injection** → A repo file that steers an agent can now also steer it into delegating. The blast radius is unchanged — the subagent holds no capability its parent lacked — but the number of ways to reach that boundary grows. Accepted: the boundary, not the path to it, is what the harness defends.

**Runner asymmetry** → The same workflow delegates under the Claude SDK runner and does not under Codex or NVIDIA. This is a real behavioral difference between providers. It is not an enforcement difference — every tool call is checked against the same capability set either way — and `agent-execution`'s equivalence requirement is scoped to allow/deny outcomes, which stay identical. Made explicit as a scenario rather than left implicit.

## Migration Plan

1. Verify token reporting for subagent sessions before anything user-facing lands.
2. Land attribution first (`ActivityEntry` fields, interceptor plumbing, panel grouping). This is independently valuable: it fixes Worktree-Agent instance attribution, which is broken today, and ships with subagents still denied.
3. Land the registry, the `Task` deny-path removal, the `subagent_type` check, and the concurrency counter behind `settings.subagents`.
4. Land the card indicator.

Rollback: set `settings.subagents: false`. No run-state migration is needed in either direction — every added field is optional and absent means "the node's own session".

## Open Questions

- ~~Does subagent usage reach `reportUsage`?~~ Settled by task 1.1: yes for tool-calling turns, possibly not for a subagent's final text turn. Under-count is bounded at one turn per subagent and accepted.
- What belongs in the registry beyond a single general worker inheriting the node's tools? A narrowed read-only `explore` type is the obvious second entry, but there is no evidence yet that splitting it earns its keep.
- Should `settings.subagents` be expressible per node as well as per run? Deferred until there is a workflow that wants it — the capability set is the per-node lever today.
