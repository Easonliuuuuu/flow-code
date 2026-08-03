# Contributing

Work happens on feature branches, merged via pull request into `main` once CI is green:

```
feature branch → pull request → CI passes → merge
```

`.github/workflows/ci.yml` runs install, lint, typecheck, and test on every PR into `main` and on every push to `main`.

Note: this is a convention, not an enforced gate. `flow-code` is currently a private repository on a GitHub plan where branch protection rules aren't available, so nothing server-side blocks a direct push to `main` or a merge with a failing check.

## Development setup

```bash
npm install
npm run build       # compile to dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src test
npm test            # vitest run
```

## Claude integration tests

`test/*.integration.test.ts` make real calls to the Claude Agent SDK rather than mocking it — they run separately via `npm run test:integration`, never as part of `npm test`, and skip themselves (not fail) when neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` is set.

`.github/workflows/claude-integration.yml` runs this suite nightly (and on demand via `workflow_dispatch`), gated on a repo secret named `CLAUDE_CODE_OAUTH_TOKEN` — the job itself is skipped entirely when that secret isn't configured, so it never blocks a contributor without one. To enable it: **Settings → Secrets and variables → Actions → New repository secret**, name `CLAUDE_CODE_OAUTH_TOKEN` (generate one with `claude setup-token`, or use a Claude CLI/subscription login).

This suite previously ran an NVIDIA NIM-backed version (`nvidia-integration.yml`) on every push to `main`; it was moved off NVIDIA's throttled free tier and off the per-push trigger after it failed the large majority of runs against shared GitHub Actions IP rate limiting.
