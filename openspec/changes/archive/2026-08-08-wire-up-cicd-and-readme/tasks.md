## 1. Branch

- [x] 1.1 Create a feature branch off `main` for this change (dogfooding the convention this change documents)

## 2. CI workflow

- [x] 2.1 Create `.github/workflows/ci.yml` with `on: pull_request` (targeting `main`) and `on: push` (to `main`) triggers
- [x] 2.2 Add job steps: checkout, `actions/setup-node` pinned to Node 20.x (matching `engines.node` in `package.json`) with npm caching enabled
- [x] 2.3 Add steps to run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test` in that order, failing fast on the first non-zero exit
- [x] 2.4 Push the branch and confirm the workflow triggers and runs to completion (pass or fail) on the resulting PR

## 3. README

- [x] 3.1 Write the opening section: what flow-code is (terminal-native node-graph interface for agentic coding workflows)
- [x] 3.2 Write the quickstart section (install, `npm run build`, run the `flow-code` CLI) using only existing `package.json` scripts
- [x] 3.3 Add a section linking to `openspec/specs/workflow-graph/spec.md` for the workflow-definition YAML format, without restating the schema
- [x] 3.4 Write the contributing section: feature branch → PR → CI green → merge, with an explicit note that this is unenforced because branch protection is unavailable on this private repo's current plan
- [x] 3.5 Add a CI status badge referencing the new workflow (optional, skip if it adds friction)

## 4. Verify and land

- [x] 4.1 Run `npm run lint`, `npm run typecheck`, and `npm run test` locally to confirm the same commands CI will run pass
- [x] 4.2 Open a pull request from the feature branch into `main` and confirm CI reports status on the PR
- [x] 4.3 Merge once CI is green

## Where this landed differently

Recorded at archive time, because the current specs were written from the shipped
result rather than from this list:

- **3.3** — the README points at `docs/workflow-reference.md` and
  `docs/node-types.md`, not at `openspec/specs/workflow-graph/spec.md`. The
  requirement behind the task (don't restate the schema in prose) held; the
  destination moved once reader-facing docs existed, and `docs/node-types.md` is
  generated from the node registry rather than written.
- **3.4** — the contribution workflow lives in `CONTRIBUTING.md`, which the
  README links to, not in a README section. The "private repo on a plan without
  branch protection" reasoning is gone with it: the repo is public, and branch
  protection is simply not configured. The unenforced-convention note survived.
- **2.3** — CI grew two verification steps after this change landed
  (`npm run docs:check`, `npm run status:check`), so the shipped pipeline is
  wider than the four commands listed here.
