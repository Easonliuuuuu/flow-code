## Why

The repo has no automated checks and no README: nothing catches a broken build/lint/test before it lands, and there's no entry point for a reader (including future-you) to understand what flow-code is or how to get started. Both are table stakes now that there's a working core engine to protect and a real GitHub remote to push to.

## What Changes

- Add a GitHub Actions workflow that runs install, lint, typecheck, and test on every pull request targeting `main` and on every push to `main`. CI only — no publish/release job.
- Add a thin `README.md`: what flow-code is, quickstart (install/build/run), and a pointer to `openspec/specs/` as the source of truth for the workflow-definition YAML format, rather than duplicating the schema in prose.
- Document the go-forward contribution convention (feature branch → PR → CI green → merge) in the README's contributing section. Note explicitly that this is convention only: `Easonliuuuuu/flow-code` is a private repo on a plan where GitHub branch protection rules aren't available, so nothing server-side blocks a direct push to `main` or a merge with a red check.

## Capabilities

### New Capabilities
- `ci-pipeline`: The GitHub Actions workflow — what triggers it, what checks it runs, and what a pass/fail means for merging.
- `project-documentation`: The README's required content — what sections must exist and what each must cover (project description, quickstart, contribution workflow), independent of exact wording.

### Modified Capabilities
(none — no existing product capability's requirements change)

## Impact

- New file: `.github/workflows/ci.yml`.
- New file: `README.md`.
- No changes to `src/`, runtime behavior, or dependencies.
- No GitHub repo-settings changes (branch protection is unavailable on this private repo's current plan; out of scope for this change).
