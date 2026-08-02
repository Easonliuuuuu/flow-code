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

## Credentials

One provider backs every agent-driven node in the project — Discuss, Implement, Validate, Review, Git-ops, and Worktree-Agent all run against whichever provider you pick. `flow-code init` is where you pick it: an interactive, arrow-key menu walks you through choosing one of

- **Claude (Anthropic)**: uses `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, or a `claude` CLI login — no key entry needed in the wizard.
- **NVIDIA NIM**: `NVIDIA_API_KEY` — get a free key at [build.nvidia.com](https://build.nvidia.com).
- **OpenAI**: `OPENAI_API_KEY`.
- **OpenRouter**: `OPENROUTER_API_KEY`.

and then a model — fetched live from the provider's model list (for Claude, a short curated list, since there's no reliable key to query with at that point), with a "custom" option to type any model id. Each provider also supports an optional second key to rotate onto under sustained rate limits.

The choice is saved to `.flow-code/credentials.json` (gitignored, `chmod 600`) and reused by every future `flow-code run` in the repo — `run` itself is fully headless and never prompts. Re-run `flow-code init --reconfigure` to change the provider or model later. If nothing is configured (`init` was never run) but the right env var is already set, `run` picks that up too — useful for CI. If neither is true and the workflow has any agent-driven node, `run` fails fast with a message pointing at `flow-code init`.

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
