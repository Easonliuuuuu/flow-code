## Why

Every agent-driven node today runs on a fixed, built-in role prompt, so the only way to teach a node how *this team* works — their code-review standards, their spec workflow — is to fork the node type. Meanwhile the ecosystem already packages exactly that knowledge as skills, and this machine alone has a dozen of them sitting in `.claude/skills/` and installed plugin marketplaces, unreachable from a workflow.

The same gap shows up in `init`: test commands are detected by hardcoded heuristics over `package.json`, `Makefile`, and a handful of language markers. A monorepo, a `tox.ini`, or a suite only expressed in `.github/workflows/` all fall through to the placeholder `echo "replace me…"`, and the user is left to hand-write the one piece of config the whole verification half of the graph depends on.

## What Changes

- **Skills attach to nodes.** Agent-driven node configs gain `skills: [...]`, a list of skill names or paths whose `SKILL.md` bodies are composed into the node's system prompt ahead of the node type's own role prompt. The node type keeps ownership of the output contract: its JSON-shape instruction is appended *after* the skill text, so routing, `failsWhen`, and output schemas are unaffected by what a skill says.
- **Skills are discovered from three roots**, matching Claude Code's own precedence: project `.claude/skills/`, user `~/.claude/skills/`, then installed plugin marketplaces (namespaced `plugin:skill`). Project shadows user; a relative path is an escape hatch for skills living outside those roots.
- **Resolution happens at load time.** An unresolvable skill is a validation error before any node runs, not a surprise mid-run. `flow-code skills` lists what is discoverable and where each resolved from; preflight reports skills resolved from user or plugin roots, since those will not resolve on a teammate's checkout of the same repo.
- **Skills are composed provider-agnostically** — the `SKILL.md` body is inlined into the system prompt, so the OpenAI, OpenRouter, and NVIDIA runners get the same behavior as the Claude runner. Bundled scripts and progressive disclosure are explicitly out of scope.
- **A skill never widens a node's capability envelope.** The node type's capability set still compiles into the enforced tool policy; a skill that asks for tools the node lacks gets denials, and those denials are visible on the node.
- **`interactive` becomes a declared node-type property**, true only for Discuss. It is enforcement-backed, not documentation: `skills:` is rejected at load time on non-agent-driven types (Test, Approval-Gate), and a non-interactive node whose session ends with a clarifying question instead of its required output fails with a message naming that cause, so an existing loop-back edge can route it.
- **An openspec workflow preset**: `flow-code init --preset openspec` scaffolds explore → propose → apply → gate → archive as Discuss/Spec/Implement/Approval-Gate/Git-ops nodes carrying the corresponding openspec skills.
- **Test-command discovery gains an agent fallback.** Heuristics still run first — free, offline, and correct for the common case. When they find nothing, or the user rejects everything they found, `init` spends one `read`-capability session to propose commands with a one-line rationale each. The user accepts or skips them exactly as today, and accepted commands are written into `workflow.yaml`.
- **Test node execution stays deterministic.** Discovery happens once at `init` and is frozen into the workflow file; `executeTest` remains a command runner with no agent, no session slot, and no token cost. Opting a node into per-run rediscovery (`commands: auto`) is available but explicitly rejected in combination with a loop-back edge into that node.

## Capabilities

### New Capabilities
- `node-skills`: discovery of skills across project, user, and plugin roots; attaching them to agent-driven nodes; load-time resolution and its failure modes; provider-agnostic composition into the system prompt; the capability envelope and output contract that bound them; and `interactive` as an enforced node-type property.
- `test-command-discovery`: how `init` determines a project's test commands — heuristics first, a read-only agent fallback, user confirmation, write-back to the workflow file — and the deterministic-execution guarantee that constrains it, including the opt-in `commands: auto` escape hatch.

### Modified Capabilities
- `workflow-graph`: node config schemas gain `skills:`; the node type registry gains `interactive` and rejects `skills:` on non-agent-driven types; `init` gains `--preset`; Test config accepts `auto` in place of a command list.
- `agent-execution`: session construction composes resolved skill text into the system prompt ahead of the role prompt and behind the capability boundary; a non-interactive node whose output contract is unmet because the session ended in a question fails with that specific cause rather than an opaque parse error.

## Impact

- **Schema and registry**: `src/workflow/schema.ts`, `src/registry/index.ts`, `src/registry/types.ts`.
- **New module** for skill discovery/resolution/composition, consumed by `src/workflow/load.ts` (resolution), `src/engine/preflight.ts` (reporting), and the executors that build prompts.
- **Executors**: `src/executors/agents.ts`, `discuss.ts`, `spec.ts` gain skill-composed prompts and the clarifying-question failure path; `src/executors/test.ts` is unchanged on the default path.
- **Runners**: skill text arrives via the existing `rolePrompt` path, so `sdkRunner.ts` and the OpenAI-compatible runners need no per-runner work.
- **Init**: `src/init/testDetect.ts` gains the agent fallback, and the test-command step must move after provider setup so a provider exists when the fallback fires — a visible reordering of the `init` flow.
- **CLI**: new `flow-code skills`; `flow-code init --preset`; `doctor` surfaces skills' `compatibility:` frontmatter.
- **Out of scope**: fetching skills over the network, bundled skill scripts, subagent-spawning skills (`Task`/`Agent` remain denied), and a per-node skill picker in the run UI.
