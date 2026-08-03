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

## NVIDIA integration tests

`test/*.integration.test.ts` make real calls to NVIDIA's NIM API rather than mocking it — they run separately via `npm run test:integration`, never as part of `npm test`, and skip themselves (not fail) when `NVIDIA_API_KEY` isn't set.

`.github/workflows/nvidia-integration.yml` runs this suite in CI on push/PR into `main`, gated on a repo secret named `NVIDIA_API_KEY` — the job itself is skipped entirely when that secret isn't configured, so it never blocks a contributor without one. To enable it: **Settings → Secrets and variables → Actions → New repository secret**, name `NVIDIA_API_KEY`.
