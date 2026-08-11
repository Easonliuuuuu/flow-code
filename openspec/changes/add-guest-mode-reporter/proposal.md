## Why

Using flow-code today means giving up the agent CLI you already use: the engine owns the model connection, so the only way to get the graph is to stop running `claude`/`codex`/`opencode` and route everything through `flow-code run`. That is a switching cost paid up front, against tools people are attached to, and it is what makes flow-code read as "another agent CLI" rather than as a layer over the one you have.

`flow-code watch` already proved the graph does not need to own execution — it renders a run purely by reading `.flow-code/runs/<runId>.json`. The only reason a watcher stays blank next to a `claude` session is that nothing writes that file unless flow-code's own engine is running. This change gives an external agent a way to write it, which turns the viewer into "keep using your tool, get a graph" without a single new session runner.

**The first version of this proposal priced that as "no harness at all," and for Claude Code specifically that price was wrong.** The harness exists because the Agent SDK exposes an interception point (`disallowedTools` + `PreToolUse` + `canUseTool`). Claude Code exposes the same interception point to any third party: a `PreToolUse` hook returns `permissionDecision: "deny"` with a reason, a `Stop` hook can refuse to end a turn and inject context, and a `SubagentStart` hook scopes a delegated agent. That is the same class of enforcement `src/harness/` already compiles, applied to a session flow-code does not own. So the design target changes: for a Claude Code host, guest mode should be a **plugin that keeps most of the harness**, not an instructions file that discloses its absence.

What that does *not* mean is that all enforcement is recoverable. flow-code does not spawn the host session, so the process-level guards in `compile.ts` (cwd, env, the `pushurl` block) do not apply, per-node model selection is gone, and token accounting is coarse. The answer is to stop treating enforcement as a boolean — a run records *which* guarantees were in force, and the viewer reports that rather than "guest" versus "real."

**This proposal is deliberately not scheduled.** It still adds a second producer of run-state, which is the M2 blocker the original version named, and that argument is untouched by anything above.

## What Changes

- **A Claude Code plugin is the primary surface.** One `/plugin install` brings the MCP report tools, the workflow skill, the hooks, and the settings that wire them — instead of an MCP server the user registers by hand plus an instructions fragment they paste. Distribution is the adoption path, and a registration step the user performs manually is a step most users do not perform.
- **A hook-installed harness in the host session.** A `PreToolUse` hook resolves the run's current node from run-state and applies that node's compiled capability set to the session's own tool calls, reusing `harness/compile.ts` and `harness/gitCommands.ts` rather than restating them. A denied call returns the same reason a driver-mode denial returns, and a git write downstream of an unapproved gate is refused in a host session exactly as it is in an engine-driven one.
- **Nodes run as host-session subagents.** A node's work is delegated to a Claude Code subagent carrying that node's role prompt, so a node still gets fresh context under the user's own config, model, and subscription. This is what keeps Review worth having: a reviewer that shares a context window with the author of the code is the author.
- **Enforcement tiers replace the guest/engine boolean.** Run-state records which tier a run ran under — `engine` (flow-code spawned the session: tool policy, process guards, accounting), `hooks` (host session with the plugin installed: tool policy and git interception, no process guards, coarse accounting), or `reported` (self-reported only). The viewer names the tier rather than implying either extreme.
- **Loop-backs become steering, not routing.** A `Stop` hook checks the current node's exit condition and, on a failing verdict, refuses to end the turn and injects the loop-back edge as context. The engine routes; a hook can only decline to let the session stop. That difference is stated rather than smoothed.
- **The `flow-code node …` CLI is retained unchanged in intent**, as the host-agnostic fallback for Codex, opencode, and anything else. It carries the `reported` tier: same validation, same writer, no enforcement claim.
- **Transition validation and reconciliation are unchanged** from the original proposal. Reported transitions are checked against the loaded graph; claimed node state is checked against the git tree. A graph that lies is worse than no graph, and enforcement in the host session does not make self-reporting truthful.

Out of scope, deliberately: per-node model selection under a host session (one session, one model), exact token accounting, parallel fan-out and worktree orchestration under a guest, interactive approval gates answered from the watch window, and any new `SessionRunner`.

## Capabilities

### New Capabilities
- `guest-run-reporting`: the run-state write surface for a process that is not flow-code's engine — MCP tools and the equivalent CLI, run lifecycle, transition validation, ownership rules that keep a guest from writing over a live driver-mode run, and the enforcement tier recorded on every run.
- `host-session-harness`: capability enforcement inside a session flow-code does not own — the hook-installed tool policy, git-write interception behind an unapproved gate, subagent scoping, and the guarantees that remain out of reach because the process was not spawned by flow-code.
- `guest-agent-instructions`: generating and installing the instructions that teach a host agent to walk the project's graph — as a plugin-delivered skill for Claude Code, as a generated instructions fragment elsewhere — and keeping them consistent with `workflow.yaml` as it changes.
- `run-state-reconciliation`: verifying reported node state against the repository's actual state and reporting disagreement, so an agent that skips its reporting duty is visible rather than invisible.

### Modified Capabilities
- `terminal-canvas-ui`: the viewer SHALL report which enforcement tier a run ran under, because a run is no longer either fully harnessed or fully unguarded, and rendering the three tiers identically would misrepresent all three.

## Impact

- **Host-specific by construction.** Everything above the `reported` tier depends on Claude Code's hook contract. Codex and opencode get the CLI surface and the `reported` tier until they expose an equivalent interception point. BR-06's success signal — "the UI is explicit about what a guest run does not enforce" — should be read as per-host, and the roadmap wording predates this split.
- **Depends on `flow-code watch`**, which exists in the working tree but has no spec coverage of its own (GAP-01). That gap should be closed before implementation, since the `terminal-canvas-ui` delta here builds on watch-mode requirements that are not yet written down.
- **New surface area**: a plugin manifest bundling an MCP server (new dependency on an MCP SDK), a skill, hook scripts, and settings; plus the existing CLI subcommands.
- **`src/harness/`**: `compileToolPolicy` and the git-command interception gain a second consumer that is not a spawned session. Expected to be a call-site change rather than a rewrite — the compile step already takes a capability set and returns data — but the process-level half of `CompiledToolPolicy` (`env`, including the `pushurl` block) has no meaning for a session flow-code did not start, and the tier model exists to say so.
- **`src/runstate/`**: a second writer of the run-state document. `RunStateStore` currently assumes a single owning process; ownership and concurrent-write rules become load-bearing rather than incidental.
- **`src/workflow/graph.ts`**: transition validation reuses the existing ordering and loop-back rules, applied to externally-reported transitions rather than to engine-driven ones.
- **Not affected**: `agent-execution` keeps its requirements unchanged. This change does not weaken how flow-code executes nodes; it adds a path where flow-code does not execute them and states what that costs.
- **Relationship to `add-mcp-driver-connector`**: unchanged in mechanism, changed in billing. Driver mode keeps flow-code as the executor, which is what makes per-node models, worktree fan-out, and unattended runs possible; this change keeps the user's own session as the executor, which is what removes the switching cost. The reason driver mode is no longer the adoption path is that a Claude Code user driving it pays for a nested Claude session that inherits none of their configuration.
- **Relationship to `add-session-status-line`**: that change ships the strip this plugin installs. It is deliberately separate because it introduces no second producer of run-state and is therefore not blocked on M2.
