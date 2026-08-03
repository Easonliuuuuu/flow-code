## 1. Skill discovery and resolution

- [x] 1.1 Add `src/skills/discover.ts`: enumerate skill directories under the project root `.claude/skills/`, `~/.claude/skills/`, and plugin marketplaces under `~/.claude/plugins/`, parsing each `SKILL.md`'s `name`/`description`/`compatibility` frontmatter and ignoring directories with no `SKILL.md`
- [x] 1.2 Implement precedence in the same module: project shadows user for unqualified names; plugin skills addressed as `plugin:skill` and excluded from shadowing either way
- [x] 1.3 Add `resolveSkill(entry, repoRoot)` handling both discovered identifiers and repo-relative paths, returning the resolved body plus its source root (`project` | `user` | `plugin` | `path`)
- [x] 1.4 Unit tests over a fixture tree for discovery, precedence, namespaced plugin ids, missing `SKILL.md`, and path-form resolution

## 2. Schema, registry, and load-time validation

- [x] 2.1 Add `interactive: boolean` to `NodeTypeDefinition` and set it on every built-in type — `true` for Discuss only
- [x] 2.2 Add optional `skills: string[]` to the Discuss, Spec, Implement, Validate, Review, Git-ops, and Worktree-Agent config schemas; leave Test and Approval-Gate without it so `strictObject` rejects the key
- [x] 2.3 Widen `testConfig.commands` to accept either a non-empty command list or the literal `auto`
- [x] 2.4 Resolve every node's `skills` entries in `src/workflow/load.ts`, failing with an error naming the node id, the unresolved entry, and the roots searched
- [x] 2.5 Reject at load time a Test node with `commands: auto` that can re-execute via a loop-back edge, naming the node id
- [x] 2.6 Tests: skills on Test/Approval-Gate rejected, unresolvable skill rejected, `auto` + loop-back rejected, resolvable workflow loads with skills attached to the right nodes

## 3. Prompt composition and execution

- [x] 3.1 Extend `AgentSessionRequest` so resolved skill text reaches the runners through the existing role-prompt path — no per-runner changes
- [x] 3.2 Compose in `src/executors/helpers.ts`: skill bodies in declaration order, then the node type's role prompt, then the type's output-shape instruction, then the boundary statement from `compileToolPolicy`
- [x] 3.3 Cap composed skill text at a documented size, reporting truncation on the node rather than silently trimming
- [x] 3.4 Record the skill identifiers a node ran with in run-state, and render them in the node detail view
- [x] 3.5 Test that `compileToolPolicy` output is byte-identical for a node with and without skills attached
- [x] 3.6 Test that composed skill text reaches the session request identically under the SDK runner and an OpenAI-compatible runner

## 4. Unmet output contracts

- [x] 4.1 Replace bare `extractJson` + zod failures in the agent executors with a classifier distinguishing "session ended asking for input" from "output present but malformed"
- [x] 4.2 Fail the node with the corresponding status detail in each case, retaining the session's final response in recorded or streamed output
- [x] 4.3 Verify the failure routes through an existing loop-back edge within its attempt bound
- [x] 4.4 Tests for both classifications and for loop-back routing of the interactivity failure

## 5. CLI surfaces

- [x] 5.1 Add `flow-code skills`: identifier, description, and source root for every discoverable skill
- [x] 5.2 Surface each resolved skill's source root in `src/engine/preflight.ts`, warning (not failing) on `user` and `plugin` roots as non-portable
- [x] 5.3 Surface discovered skills' `compatibility` frontmatter in `doctor`
- [x] 5.4 Extend `flow-code node-types` to print agent-driven and interactive per type
- [x] 5.5 Tests for the listing output, the preflight warning, and its absence when every skill is project-local

## 6. Test-command discovery

- [x] 6.1 Move the test-command step in `init` to run after provider/model setup, keeping its prompts unchanged
- [x] 6.2 Add the `read`-capability agent fallback: triggered when heuristics yield nothing or the user declines every candidate, proposing commands each with a one-line rationale
- [x] 6.3 Skip the fallback with an explanatory message when no provider is configured, leaving the placeholder in place and letting `init` finish
- [x] 6.4 Route accepted commands through the existing accept/skip prompts and the existing write-back to the Test node's config
- [x] 6.5 Implement `commands: auto` in `executeTest`: rediscover via a `read`-capability session at the start of execution, then run the result
- [x] 6.6 Tests: heuristics-first ordering, fallback trigger conditions, no-provider skip, no command executed before acceptance, write-back contents and order

## 7. Openspec preset

- [x] 7.1 Add `--preset <name>` to `flow-code init`, failing on an unknown name with the available names listed and no file written
- [x] 7.2 Add the openspec preset: explore (Discuss) → propose (Spec) → apply (Implement) → gate (Approval-Gate) → archive (Git-ops), with the matching openspec skills attached and loop-backs consistent with the default scaffold
- [x] 7.3 Warn at scaffold time when a preset's skills do not resolve, naming which and where they are expected
- [x] 7.4 Test that the preset's output passes normal workflow validation and that the no-preset path still scaffolds the default graph unchanged

## 8. Documentation

- [x] 8.1 README: attaching skills, the three discovery roots and their precedence, and the portability caveat
- [x] 8.2 README: the openspec preset, and the interactive/decision/none interaction modes with the guidance to insert a gate rather than seek an interactive Implement
- [x] 8.3 README: the reordered `init` flow, the agent fallback for test commands, and why Test execution stays deterministic including the `auto` restriction
- [x] 8.4 Update the scaffolded `DEFAULT_WORKFLOW_YAML` comments to mention `skills:` on agent-driven nodes
