## Context

Two related gaps, both about where a node's instructions come from.

Today an agent-driven node's system prompt is `${rolePrompt}\n\n${boundaryPrompt}`, built in `sdkRunner.ts` and its OpenAI-compatible siblings from a `NodeTypeDefinition.rolePrompt` string baked into `src/registry/index.ts`. There is no mechanism to give a node project-specific instructions short of forking a node type. Meanwhile skills — packaged instructions with `name`/`description` frontmatter — already exist on developer machines in three places, and on this repo alone `.claude/skills/` holds six of them (the openspec set, `git-commit`), each a single `SKILL.md` of 111–215 lines.

The second gap is in `init`. `src/init/testDetect.ts` derives test commands from hardcoded heuristics over `package.json`, `Makefile`, and language markers. When they miss, `.flow-code/workflow.yaml` keeps the placeholder `echo "replace me…"`, and the Test node — the graph's only non-judgmental verification step — is inert.

Constraints that shape everything below:

- **Four runners, one prompt path.** `sdkRunner`, `openaiRunner`, `openrouterRunner`, and `nvidiaRunner` all consume the same `AgentSessionRequest`. Anything provider-specific has to be built four times.
- **Capabilities are structural.** `compileToolPolicy()` turns a node type's capability set into deny lists, env, and hook enforcement. Prompt text has never been load-bearing for permissions, and must not become so.
- **Test is the only deterministic verdict.** Validate and Review are model judgments; Test is `exit 0`. The default workflow loops back from all three into Implement.
- **`workflow.yaml` is checked in.** Anything referenced from it should resolve on a teammate's machine, or say loudly that it will not.

## Goals / Non-Goals

**Goals:**

- Attach existing, unmodified skills to agent-driven nodes without touching node types.
- Identical behavior across all four provider runners.
- Keep every routing guarantee — output schemas, `failsWhen`, loop-backs — independent of what a skill says.
- Fail at load time, not mid-run, for anything unresolvable.
- Let `init` find test commands in projects the heuristics can't read, without making the Test node's verdict a model's opinion.

**Non-Goals:**

- Fetching skills over the network, or any marketplace install flow. Discovery reads what is already on disk.
- Executing scripts bundled next to a `SKILL.md`, or reproducing progressive disclosure. Only the `SKILL.md` body is used.
- Skills that spawn subagents. `Task`/`Agent` stay in `ALWAYS_DENIED_TOOLS`.
- A per-node skill picker in the run UI. Selection happens in `init` and in the workflow file.
- Any change to how the Test node executes commands on the default path.

## Decisions

### Skills are role-prompt material, not node types

The alternative — a node type per skill, e.g. four new openspec types — was rejected. `explore`/`propose`/`apply`/`archive` are not new *kinds* of node; they are Discuss/Spec/Implement/Git-ops with different instructions. Adding them to `NODE_TYPE_IDS` would mean four more capability sets, config schemas, output schemas and failure predicates to maintain, to express something the existing graph already expresses. Openspec ships instead as a **workflow preset** — a scaffolded `workflow.yaml`, not registry surface.

This also fixes the ownership question cleanly: the skill governs *how* the node works, the node type governs *what it must return*. Composition order enforces it — skill text, then role prompt, then the type's output-shape instruction, then the boundary statement. A skill that prescribes a prose report cannot stop a Review node from having to emit `reviewOutput`.

### Compose by inlining `SKILL.md`, not by native SDK loading

The Claude Agent SDK can load skills natively via `settingSources`, but `sdk.d.ts` is explicit that `settingSources` "has no effect when `systemPrompt` is a string" — and `sdkRunner.ts` passes a string. Switching to `{ type: 'preset', preset: 'claude_code', append }` would drag in CLAUDE.md and the full Claude Code preamble for every node, changing behavior everywhere, and would still leave the three OpenAI-compatible runners with nothing.

Inlining the markdown into the existing `rolePrompt` field works identically on all four runners and requires zero runner changes. The cost is progressive disclosure and bundled scripts — irrelevant for the single-file, ~150-line skills this is aimed at. If a class of skill emerges where that cost bites, native loading can be added later for the Claude runner as an optimization behind the same config surface.

**Alternative considered:** a skill-to-subagent mapping via the SDK's `agents` option. Rejected — subagent tool calls would run outside `intercept.ts`, which is exactly why `Task`/`Agent` are denied today.

> **Superseded — see the `node-subagents` change.** The premise above stopped being true: the SDK's `PreToolUse` hook now fires for subagent tool calls, carrying `agent_id`/`agent_type`, which was verified against a live session before subagents were allowed. Left as written because it was correct when decided; this note exists so the rationale is not read as current.

### Three discovery roots, resolved once at load time

Project `.claude/skills/` → user `~/.claude/skills/` → plugin marketplaces under `~/.claude/plugins/`, with project shadowing user and plugin skills namespaced `plugin:skill`. This mirrors Claude Code's own precedence, so there is no second mental model to learn.

The initial instinct was to allow project-local paths only, on supply-chain grounds. That conflated *fetching over the network* with *reading what is already on the machine*: a skill in `~/.claude/skills/` is already trusted by the user's own Claude Code. The real cost of non-project roots is **portability** — a checked-in workflow referencing a machine-local skill breaks on a teammate's clone. The mitigation is visibility, not restriction: resolve at load time so a missing skill is a validation error before anything runs, report each skill's source root in preflight, and warn on user/plugin roots. `flow-code skills` lists what is attachable; `doctor` surfaces the `compatibility:` frontmatter (the openspec skills declare `Requires openspec CLI`).

### Interactivity is already structural; make it declared

`discuss.ts` calls `sessions.openInteractive()` and loops on `ports.discuss.nextUserMessage()`. Every other agent node calls `sessions.run()` once. So "Discuss can stop and ask; Implement and Test cannot" is already true and enforced by which API the executor calls — there is nothing to build to make it so. What is missing is a *declared* `interactive: boolean` on `NodeTypeDefinition`, so the property can be reasoned about and displayed rather than inferred from executor source.

Note there are three interaction modes, not two: conversational (Discuss), decision (Approval-Gate, blocks with no session), and none. When a user wants to intervene mid-implementation, the answer is inserting a gate — not making Implement interactive.

**The failure this creates:** a skill written for interactive use (`openspec-explore` is a conversation) attached to a headless node. It cannot hang — there is no port to block on. What happens is the session ends with a clarifying question instead of JSON, and `extractJson` + zod throw an opaque parse error. Rather than trying to detect interaction-shaped skills from frontmatter (which carries no such field), classify the failure at the point it occurs: no conforming output + a final response that reads as a request for input ⇒ fail with that named cause, routable by the existing loop-back. Structure enforces the rule; the error message explains it.

For the openspec preset this resolves itself: `explore` is a Discuss node that front-loads the questions, and `propose` runs headless off `discussOutput`'s `{conclusion, constraints}` — which is exactly what that output shape exists to carry.

### Test discovery is agent-driven; test execution is not

Making `executeTest` agent-driven was rejected on a specific failure mode, not on principle. The default workflow loops back Test → Implement. If the Test node re-derives its own commands each run, the retry loop becomes: Implement fails the suite → loops back → the same agent now also chooses which commands constitute "the suite," with three attempts to find an easier one. The thing being graded picks its own exam.

Two supporting reasons: `executeTest` costs zero tokens and no session slot today, and `workflow.yaml` being checked in means the same commit should test identically for everyone.

There is also a real safety edge. `executeTest` spawns `sh -c` **directly** — it is not inside the harness, so there is no interception and no capability clamp on it. Agent-authored command strings running there that no human has ever read is a different risk class from agent tool calls inside a sandboxed session. Hence: propose, show, confirm once, freeze into the file.

So the flow in `init` becomes heuristics → (nothing found, or all declined) → one `read`-capability agent session proposing commands with rationales → the same accept/skip prompts as today → write-back. The common case costs nothing; a model is spent only where the heuristics actually failed, which is the case worth paying for.

**Ordering consequence:** `init` currently runs test detection *before* provider setup. The agent fallback needs a configured provider, so the two steps swap. If no provider is configured when the fallback would fire (e.g. the user cancels provider setup), it is skipped with a message rather than failing `init`.

**`commands: auto`** exists as an explicit opt-in for users who prefer convenience, and is rejected at load time when a loop-back can cause that node to re-execute — the one combination that reintroduces the closed loop above.

## Risks / Trade-offs

- **A skill written for interactive Claude Code misbehaves on a headless node** → cannot hang (no input channel); fails with a named, routable cause; the preset places conversational skills only on Discuss.
- **Machine-local skills break a teammate's clone** → load-time resolution failure with the searched roots named, plus a preflight warning whenever a skill resolves outside the repo.
- **Inlining loses progressive disclosure; large skills inflate every turn's prompt** → target skills are ~150 lines; cap composed skill text and report when a skill is truncated. Native loading remains available later behind the same config surface.
- **A skill instructs the agent toward tools the node lacks, and the node flails against denials** → denials are already logged by `intercept.ts` and surfaced on the node; the boundary statement is composed last so it is the most recent instruction in the prompt.
- **The agent fallback proposes a destructive command** (`make clean`, a db reset) → never executed to validate it, always shown with its rationale, always requires explicit acceptance, always lands in a reviewable diff.
- **Two config surfaces for the same idea if `settings.skills` is added later** → deliberately not adding run-wide skills in this change; per-node only.
- **`init` step reordering surprises existing users** → `init` on an already-configured project already asks before reconfiguring; the reordering is visible in its printed flow.

## Migration Plan

Purely additive. `skills` is optional on every config schema, `interactive` is derived from existing behavior, and `commands` keeps accepting the list form it accepts today. Existing `workflow.yaml` files load and run unchanged with no edits. Rollback is removing the `skills` keys from a workflow file.

## Open Questions

- Should composed skill text count against `budget.tokensPerNode` visibly — i.e. does the node card show prompt overhead attributable to skills?
- Does `flow-code skills` need to resolve plugin marketplaces that are cloned but not enabled in settings, or only enabled ones?
- Should the openspec preset also scaffold the `openspec/` directory when absent, or require `openspec init` to have been run first?
