# Contributing

Work happens on feature branches, merged via pull request into `main` once CI is green:

```
feature branch → pull request → CI passes → merge
```

`.github/workflows/ci.yml` runs install, lint, typecheck, and test on every PR into `main` and on every push to `main`.

Note: this is a convention, not an enforced gate — no branch protection rule is configured, so nothing server-side blocks a direct push to `main` or a merge with a failing check.

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

## Knowing what you're building

[`STATUS.md`](STATUS.md) is the rollup of where the product is — generated, never hand-edited. What it is measured against lives in [`docs/product/`](docs/product/README.md): the brief, the roadmap of business requirements, and `coverage.yaml`, the ledger mapping commit scopes and `src/` modules to the capability specs that own them.

CI runs `npm run status:check`, which fails if `STATUS.md` is stale, or if a feature shipped without a capability spec owning it and without being registered as a known gap. If it fails on your change: write the spec, map it to an existing capability, or register it as a gap with a reason. Don't widen a mapping until the warning disappears — see [`docs/product/README.md`](docs/product/README.md).

Got an idea mid-flow? One line in [`docs/product/inbox.md`](docs/product/inbox.md). No format, no ID.

## Live integration tests

`test/*.integration.test.ts` make real calls to a provider's API rather than mocking it — they run separately via `npm run test:integration`, never as part of `npm test`, and skip themselves (not fail) when the credentials they need aren't set. Today that's one suite, `live.integration.test.ts`, against the Claude Agent SDK (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`); a second provider would get its own `*.integration.test.ts` file rather than a branch inside this one.

`.github/workflows/live-integration.yml` runs this suite nightly (and on demand via `workflow_dispatch`), gated on a repo secret named `CLAUDE_CODE_OAUTH_TOKEN` — the job itself is skipped entirely when that secret isn't configured, so it never blocks a contributor without one. To enable it: **Settings → Secrets and variables → Actions → New repository secret**, name `CLAUDE_CODE_OAUTH_TOKEN` (generate one with `claude setup-token`, or use a Claude CLI/subscription login).

This suite previously ran against a different provider on every push to `main`; it was moved to a nightly cadence after failing the large majority of runs against that provider's shared rate limiting.
