## 1. Branch

- [ ] 1.1 Create a feature branch off `main` for this change (dogfooding the convention this change documents)

## 2. CI workflow

- [ ] 2.1 Create `.github/workflows/ci.yml` with `on: pull_request` (targeting `main`) and `on: push` (to `main`) triggers
- [ ] 2.2 Add job steps: checkout, `actions/setup-node` pinned to Node 20.x (matching `engines.node` in `package.json`) with npm caching enabled
- [ ] 2.3 Add steps to run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test` in that order, failing fast on the first non-zero exit
- [ ] 2.4 Push the branch and confirm the workflow triggers and runs to completion (pass or fail) on the resulting PR

## 3. README

- [ ] 3.1 Write the opening section: what flow-code is (terminal-native node-graph interface for agentic coding workflows)
- [ ] 3.2 Write the quickstart section (install, `npm run build`, run the `flow-code` CLI) using only existing `package.json` scripts
- [ ] 3.3 Add a section linking to `openspec/specs/workflow-graph/spec.md` for the workflow-definition YAML format, without restating the schema
- [ ] 3.4 Write the contributing section: feature branch → PR → CI green → merge, with an explicit note that this is unenforced because branch protection is unavailable on this private repo's current plan
- [ ] 3.5 Add a CI status badge referencing the new workflow (optional, skip if it adds friction)

## 4. Verify and land

- [ ] 4.1 Run `npm run lint`, `npm run typecheck`, and `npm run test` locally to confirm the same commands CI will run pass
- [ ] 4.2 Open a pull request from the feature branch into `main` and confirm CI reports status on the PR
- [ ] 4.3 Merge once CI is green
