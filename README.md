# flow-code

[![CI](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml)

A terminal-native, node-graph interface for running and observing agentic coding workflows. Instead of a scrolling chat log, a coding task's lifecycle — spec discussion, implementation, validation, review, git operations — renders as a live, interactive graph in your terminal, with support for fanning work out across multiple agents in isolated git worktrees.

## Quickstart

```bash
npm install
npm run build
node dist/cli.js init   # scaffold .flow-code/workflow.yaml in a git repo
node dist/cli.js run    # run the workflow graph
```

Once installed globally or linked (`npm link`), the same commands are available as `flow-code init` / `flow-code run`. Run `flow-code help` for the full command list (`init`, `run`, `node-types`, `doctor`).

## Credentials

Agent-driven nodes are routed by node type: Discuss runs on the Claude Agent SDK; Implement, Validate, Review, Git-ops, and Worktree-Agent run on NVIDIA's NIM API. `flow-code run` checks for both before starting anything, but only requires the one(s) your workflow actually needs:

- **Claude** (required if your workflow has a Discuss node): set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or be logged in via the `claude` CLI.
- **NVIDIA** (required if your workflow has any other agent-driven node): set `NVIDIA_API_KEY` — get a free key at [build.nvidia.com](https://build.nvidia.com).

## Configuring a workflow

Workflows are defined per-project in `.flow-code/workflow.yaml`. The full schema — node types, capabilities, edges, and run settings — is documented in [`openspec/specs/workflow-graph/spec.md`](openspec/specs/workflow-graph/spec.md), which is the source of truth for the config format.

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
