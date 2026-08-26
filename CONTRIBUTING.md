# Contributing

Work happens on feature branches, merged via pull request into `main` once CI is green:

```
feature branch → pull request → CI passes → merge
```

`.github/workflows/ci.yml` runs install, lint, typecheck, and test on every PR into `main` and on every push to `main`.

Note: this is a convention, not an enforced gate — no branch protection rule is configured, so nothing server-side blocks a direct push to `main` or a merge with a failing check.

## Commit messages

Conventional commits, because two generated things read them:

```
feat(ops.ts): add a --dry-run flag
fix(engine): stop a rejected gate from consuming a retry
docs(security.md): document what a run record contains
chore(deps): bump vitest
```

The scope is a bare file or folder name — `ops.ts`, `engine`, `presets.ts` —
never a path. `npm run status:check` reads every `feat()` scope to find features
that shipped without a capability spec owning them, and release-please reads the
types to decide the next version and write the changelog. A message outside this
format is not rejected by a linter, but it goes uncounted by the first and
invisible to the second.

## Development setup

```bash
npm install
npm run build       # compile to dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src test
npm test            # vitest run
npm run status      # regenerate STATUS.md
```

`npm install` does not build: the build hook is `prepack`, so it runs when the
package is packed rather than during anyone's install — a `prepare` hook would
run inside consumers' installs too, where the published package has no source
to compile. Run `npm run build` yourself before anything that reads `dist/`
(`npm run docs:check`, the demo scripts, the `testbed` skill). `npm test`,
`npm run lint`, and `npm run typecheck` all read `src/` and need no build.

## A note on `.flow-code/` in this repo

flow-code writes a `.flow-code/.gitignore` into the repositories it is used on,
which keeps `workflow.yaml` tracked and everything else — credentials, run
records, transcripts — out of git. That is the advice the
[README](README.md) and [docs/security.md](docs/security.md) give, and it is
what users should follow.

**This repository ignores the whole directory instead**, via the root
`.gitignore`. Not an oversight and not disagreement with the advice: here
`.flow-code/` is the tool's own scratch space — multi-megabyte demo captures,
throwaway runs against fixtures, a workflow.yaml that gets rewritten by whatever
preset is being tested that afternoon. None of it is project history. A nested
ignore file would also be the wrong tool for the job, since a deeper
`.gitignore` overrides a shallower one and the `!workflow.yaml` line would win.

## Knowing what you're building

[`STATUS.md`](STATUS.md) is the rollup of where the product is — generated, never hand-edited. What it is measured against lives in [`docs/product/`](docs/product/README.md): the brief, the roadmap of business requirements, and `coverage.yaml`, the ledger mapping commit scopes and `src/` modules to the capability specs that own them.

CI runs `npm run status:check`, which fails if `STATUS.md` is stale, or if a feature shipped without a capability spec owning it and without being registered as a known gap. If it fails on your change: write the spec, map it to an existing capability, or register it as a gap with a reason. Don't widen a mapping until the warning disappears — see [`docs/product/README.md`](docs/product/README.md).

Got an idea mid-flow? One line in [`docs/product/inbox.md`](docs/product/inbox.md). No format, no ID.

## Live integration tests

`test/*.integration.test.ts` make real calls to a provider's API rather than mocking it — they run separately via `npm run test:integration`, never as part of `npm test`, and skip themselves (not fail) when the credentials they need aren't set. The suites are provider-local: `live.integration.test.ts` covers the Claude Agent SDK (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), `codex.integration.test.ts` covers Codex when explicitly opted in with `CODEX_INTEGRATION=1` plus Codex credentials, and `openai.integration.test.ts` covers OpenAI chat completions (`OPENAI_API_KEY`).

`.github/workflows/live-integration.yml` runs each configured provider job nightly (and on demand via `workflow_dispatch`), gated on its own repository secret — the job is skipped entirely when that provider is not configured, so it never blocks a contributor without one. Locally, `npm run test:integration` has the same credential-gated behavior; `npm run test:integration:local` additionally loads a project `.env` file. To enable a job: **Settings → Secrets and variables → Actions → New repository secret**, add `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for Claude, `CODEX_API_KEY` for Codex, or `OPENAI_API_KEY` for OpenAI. Codex also requires `CODEX_INTEGRATION=1` locally; CI sets that opt-in automatically.

This suite previously ran against a different provider on every push to `main`; it was moved to a nightly cadence after failing the large majority of runs against that provider's shared rate limiting.
