# flow-code

[![CI](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml)

A terminal-native, node-graph interface for running and observing agentic coding workflows. Instead of a scrolling chat log, a coding task's lifecycle — spec discussion, implementation, validation, review, git operations — renders as a live, interactive graph in your terminal, with support for fanning work out across multiple agents in isolated git worktrees.

## Quickstart

```bash
npm install
npm run build
node dist/cli.js init   # scaffold .flow-code/workflow.yaml and pick a provider/model
node dist/cli.js run    # run the workflow graph
```

Once installed globally or linked (`npm link`), the same commands are available as `flow-code init` / `flow-code run`. Run `flow-code help` for the full command list (`init`, `run`, `node-types`, `doctor`).

## Test command setup

Right after scaffolding `.flow-code/workflow.yaml`, `flow-code init` looks for how this project runs its tests — `package.json` scripts, a `Makefile` target, `pytest`/`go test`/`cargo test` markers — and offers each one it finds for you to accept or skip:

```
flow-code: created .flow-code/workflow.yaml
  Default graph: discuss → implement → test → validate → review → gate → git-ops

flow-code: set up the command(s) the Test node runs.

  Detected 2 possible test commands:
  Include `npm test`? [Y/n]
  Include `npm run test:e2e`? [Y/n]
  Add another test command? [y/N]
flow-code: saved 2 test commands to .flow-code/workflow.yaml.
```

Nothing detected (a brand-new project with no tests yet) just skips straight through, leaving the scaffolded placeholder (`echo "replace me with your project's test command"`) in place — a harmless no-op until you're ready to fill it in, by hand or by re-running `flow-code init`. Multiple commands run in order in the Test node; the first failing one stops it, so unit/integration/e2e levels can each be their own entry.

## Provider & model setup

One provider backs every agent-driven node in the project — Discuss, Implement, Validate, Review, Git-ops, and Worktree-Agent all run against whichever provider you pick. `flow-code init` walks through picking it right after the test-command step:

```
flow-code: pick the provider and model that will back every agent-driven node.

Provider:
❯ Claude (Anthropic)
  NVIDIA NIM
  OpenAI
  OpenRouter
```

Move with **↑/↓** (or **j/k**), confirm with **enter**, back out with **esc** or **ctrl+c** (nothing is saved on cancel). What happens next depends on the provider:

- **Claude**: no key prompt — it uses `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, or a `claude` CLI login. If none of those are detected yet, the wizard just warns you and keeps going; log in before your first `flow-code run`.
- **NVIDIA NIM** / **OpenAI** / **OpenRouter**: you're prompted to paste an API key (masked as you type), then asked whether to add a second key on a different account to rotate onto under sustained rate limits.

It then fetches the provider's live model list (a short curated list for Claude, since there's no key to query with at that point) and shows the same kind of picker, with a custom entry at the bottom for typing any model id — useful if the one you want isn't listed, or the fetch failed:

```
Model:
❯ gpt-4o
  gpt-4o-mini
  gpt-4-turbo
  (custom — type a model id)
```

Once picked, it's saved and confirmed:

```
flow-code: saved to .flow-code/credentials.json (gitignored, chmod 600).
flow-code: configured OpenAI / gpt-4o-mini for this project.
  Start a run with: flow-code run
```

From here, `flow-code run` is fully headless — it reuses the saved provider/model with no prompts, every time. Running `flow-code init` again just prints what's configured and asks whether to reconfigure — say no and it exits immediately, no flags to remember:

```
flow-code: provider already configured (OpenAI, model gpt-4o-mini).
  Reconfigure the provider/model? [y/N]
```

### Headless / CI usage

`flow-code run` never prompts. If `.flow-code/credentials.json` isn't present (e.g. a fresh CI checkout that never ran `init`), it falls back to whichever of these env vars is set, in this order — useful for setting up a provider without the interactive wizard at all:

- `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` → Claude (Anthropic)
- `NVIDIA_API_KEY` → NVIDIA NIM (get a free key at [build.nvidia.com](https://build.nvidia.com))
- `OPENAI_API_KEY` → OpenAI
- `OPENROUTER_API_KEY` → OpenRouter

If none of those are set and the workflow has any agent-driven node, `run` fails fast with a message pointing at `flow-code init` instead of hanging on a prompt.

## Configuring a workflow

Workflows are defined per-project in `.flow-code/workflow.yaml`. The full schema — node types, capabilities, edges, and run settings — is documented in [`openspec/specs/workflow-graph/spec.md`](openspec/specs/workflow-graph/spec.md), which is the source of truth for the config format.

### Iterating on failure

Validate and Review fail their node when they return a `fail` verdict, which by default stops the run there. To iterate instead of stopping, add a **loop-back edge**: when its `from` node fails, execution returns to its `to` node and re-runs every node on the path between them, with the failure injected as context so the retry knows what to fix.

```yaml
edges:
  - { from: implement, to: validate }
  # On a failing verdict, go back to implement and try again.
  - { from: validate, to: implement, loopback: true }
  # Or set the bound explicitly:
  - { from: validate, to: implement, loopback: { maxAttempts: 5 } }
```

A loop-back must point back to a node upstream of its source — this is checked before the run starts. Every loop-back is bounded (`maxAttempts` defaults to **3**, counted per target node), so a loop that never converges still terminates: the failing node stays in `error`, its downstream nodes are skipped, and the status detail says the attempt limit was reached. Loop-backs are drawn as return paths below the graph, and a node that has been re-run carries a `↻N` badge.

A rejected Approval-Gate works the same way: with a loop-back declared it sends the segment back for another pass, and without one it halts the branch as before.

## Contributing

Work happens on feature branches, merged via pull request into `main` once CI is green:

```
feature branch → pull request → CI passes → merge
```

`.github/workflows/ci.yml` runs install, lint, typecheck, and test on every PR into `main` and on every push to `main`.

Note: this is a convention, not an enforced gate. `flow-code` is currently a private repository on a GitHub plan where branch protection rules aren't available, so nothing server-side blocks a direct push to `main` or a merge with a failing check.

### NVIDIA integration tests

`test/*.integration.test.ts` make real calls to NVIDIA's NIM API rather than mocking it — they run separately via `npm run test:integration`, never as part of `npm test`, and skip themselves (not fail) when `NVIDIA_API_KEY` isn't set.

`.github/workflows/nvidia-integration.yml` runs this suite in CI on push/PR into `main`, gated on a repo secret named `NVIDIA_API_KEY` — the job itself is skipped entirely when that secret isn't configured, so it never blocks a contributor without one. To enable it: **Settings → Secrets and variables → Actions → New repository secret**, name `NVIDIA_API_KEY`.

## License

MIT
