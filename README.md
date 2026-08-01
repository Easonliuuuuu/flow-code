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

## Configuring a workflow

Workflows are defined per-project in `.flow-code/workflow.yaml`. The full schema — node types, capabilities, edges, and run settings — is documented in [`openspec/specs/workflow-graph/spec.md`](openspec/specs/workflow-graph/spec.md), which is the source of truth for the config format.

## Contributing

Work happens on feature branches, merged via pull request into `main` once CI is green:

```
feature branch → pull request → CI passes → merge
```

`.github/workflows/ci.yml` runs install, lint, typecheck, and test on every PR into `main` and on every push to `main`.

Note: this is a convention, not an enforced gate. `flow-code` is currently a private repository on a GitHub plan where branch protection rules aren't available, so nothing server-side blocks a direct push to `main` or a merge with a failing check.

## License

MIT
