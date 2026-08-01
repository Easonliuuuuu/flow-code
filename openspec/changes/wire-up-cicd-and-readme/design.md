## Context

`flow-code` has a real GitHub remote (`Easonliuuuuu/flow-code`, private) but no `.github/` directory and no `README.md`. The test suite (1640 lines across 9 files) already exercises real git behavior — `test/helpers.ts` shells out to `git init`/`git config`/`git commit` in temp directories, and `worktree.test.ts`/`e2e.test.ts` create real `git worktree` checkouts. `vitest.config.ts` sets a 30s per-test timeout, suggesting these aren't instant. `package.json` declares `engines: { node: ">=20" }` and already has `lint`, `typecheck`, `test`, and `build` scripts wired up — CI just needs to run what already exists, not invent new tooling.

The repo is private on a GitHub plan where branch protection rules aren't available, so there is no server-side way to block a red merge or a direct push to `main`. That's a constraint to document, not solve here.

## Goals / Non-Goals

**Goals:**
- Run lint, typecheck, and test automatically on every PR into `main` and every push to `main`.
- Give the repo a README that orients a reader in under a minute and points to `openspec/specs/` for the workflow-YAML schema instead of duplicating it.
- Document the feature-branch → PR → CI-green → merge convention, and be explicit that it's unenforced on this plan/repo visibility.

**Non-Goals:**
- No publish/release job (npm publish, GitHub Release, versioning) — `0.1.0` isn't ready to be public package infrastructure yet.
- No GitHub repo-settings changes (branch protection, required reviewers) — unavailable on this plan; revisit if the repo goes public, gets collaborators, or the plan changes.
- No OS/Node version matrix — this is a Node CLI tool, not a cross-platform library; test against the `engines` floor only.
- No full documentation of the workflow-definition YAML schema in the README — that lives in `openspec/specs/workflow-graph/spec.md` and would drift if duplicated.

## Decisions

**GitHub Actions, single workflow file (`.github/workflows/ci.yml`).**
Native to GitHub, no external service/account to wire up, and the repo is already hosted there. A single job (`checkout` → `setup-node` → `npm ci` → `lint` → `typecheck` → `test`) is enough; there's no reason to split into parallel jobs for a suite this size, and splitting would add matrix/artifact-passing complexity for no real speedup.

**Trigger on `pull_request` (targeting `main`) and `push` (to `main`).**
`pull_request` gives status on the PR itself (visible even without branch protection). `push: main` is a backstop that catches anything merged or pushed directly, and covers this repo's history of direct-to-main commits until the branch convention is actually adopted.

**Pin runner Node version to the `engines` floor (20.x), not `ubuntu-latest`'s default/latest.**
The dev machine runs Node 24; if CI silently tracked "latest" it would never catch a `>=20`-breaking regression. Testing the floor is the more meaningful signal given `engines` is the only compatibility promise in `package.json`.

**`ubuntu-latest` only, no OS matrix.**
Non-goal per above — this isn't a library being installed on arbitrary platforms today; revisit if that changes.

**README stays thin: what it is, quickstart, link to specs, contributing note.**
Two sources of truth for the same YAML schema (README prose + `openspec/specs/workflow-graph/spec.md`) will drift the first time one is updated and not the other. The README links out instead.

## Risks / Trade-offs

- **[Risk]** `worktree.test.ts`/`e2e.test.ts` create real git repos and worktrees per test via `mkdtempSync`; if CI runtime or flakiness turns out worse than local, the fix is investigating parallelism (vitest's default multi-process pool) rather than something to preempt now → Mitigation: ship as-is, watch first few CI runs.
- **[Risk]** Documenting "branch protection isn't available" in the README goes stale if the plan changes or the repo goes public → Mitigation: phrase it as current state tied to repo visibility/plan, not a permanent architectural fact.
- **[Trade-off]** No required-review/required-check gate means CI failures are advisory, not blocking → Accepted per proposal; this change's job is visibility, not enforcement.

## Migration Plan

Purely additive (two new files, no code/dependency changes) — no rollback complexity beyond reverting the PR. This change is itself a natural first test of the convention it documents: land it via a feature branch and PR rather than a direct commit to `main`.
