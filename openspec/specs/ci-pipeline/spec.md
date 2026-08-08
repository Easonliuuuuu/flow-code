# ci-pipeline

## Purpose

The repository's automated gate: what runs on a change before it can merge, what
that gate is allowed to conclude, and how a merged change becomes a published
release without hand-assembled steps. This capability is about the project's own
quality bar, not about anything a user of flow-code experiences.

## Requirements

### Requirement: CI runs on pull requests targeting main
The system SHALL run a verification workflow on every pull request that targets the `main` branch.

#### Scenario: PR opened against main
- **WHEN** a pull request is opened or updated targeting `main`
- **THEN** the CI workflow runs and reports its status on the pull request

### Requirement: CI runs on pushes to main
The system SHALL run the same verification workflow on every push to `main`, independent of whether the push came through a merged pull request or a direct push.

#### Scenario: Direct push to main
- **WHEN** a commit is pushed directly to `main`
- **THEN** the CI workflow runs and reports pass/fail status for that commit

### Requirement: CI verifies code, generated docs, and the product ledger
The CI workflow SHALL install dependencies and then verify, failing the run on the first non-zero exit: lint, types, tests, that generated documentation matches its source of truth, and that the product ledger has no unregistered drift.

Each of these checks SHALL be runnable locally by the same npm script CI invokes, so that a contributor can reproduce a failure without pushing.

#### Scenario: All checks pass
- **WHEN** the workflow runs `npm ci` followed by `npm run lint`, `npm run typecheck`, `npm run test`, `npm run docs:check`, and `npm run status:check`, and all succeed
- **THEN** the workflow reports an overall success status

#### Scenario: A check fails
- **WHEN** any verification step exits non-zero
- **THEN** the workflow reports an overall failure status and stops before running later steps

#### Scenario: Generated documentation was not regenerated
- **WHEN** a change edits the node type registry without regenerating `docs/node-types.md`
- **THEN** `npm run docs:check` fails the run rather than letting the documentation diverge silently

#### Scenario: A feature shipped without a capability spec owning it
- **WHEN** a change adds a `feat(<scope>)` commit or a `src/` module that no capability spec owns and that is not registered as a known gap
- **THEN** `npm run status:check` fails the run

### Requirement: CI targets the engines floor, not the latest Node version
The CI workflow SHALL run against the Node.js major version declared as the floor in `package.json`'s `engines.node` field, not an unpinned "latest" version.

#### Scenario: engines floor is Node 20
- **WHEN** `package.json` declares `"engines": { "node": ">=20" }`
- **THEN** the CI workflow's runner is configured to use Node 20.x

### Requirement: CI checks out history deep enough for the checks it runs
The CI workflow SHALL check out enough git history for every verification step to reach its conclusion honestly. Where a check derives its answer from commit history, a truncated checkout SHALL NOT be allowed to produce a pass.

#### Scenario: The ledger check reads commit history
- **WHEN** `npm run status:check` runs in CI and derives drift from every `feat(<scope>)` commit in the repository
- **THEN** the checkout SHALL be full-depth, and the check itself SHALL refuse to report success on a shallow clone rather than passing on a partial view of history

### Requirement: CI does not publish or release
The CI workflow SHALL be limited to verification and SHALL NOT publish a package to any registry or create a release or tag.

#### Scenario: Workflow run completes
- **WHEN** the CI workflow finishes, regardless of pass or fail
- **THEN** no package is published and no release or tag is created as a side effect

### Requirement: A release is a merge, not a procedure
Releasing SHALL be automated in a workflow separate from CI, driven by the conventional-commit history on `main`. The human decision SHALL be a single merge; version selection, changelog generation, tagging, and registry publication SHALL follow from it without further manual steps.

#### Scenario: Changes accumulate on main
- **WHEN** commits land on `main`
- **THEN** a release pull request is kept up to date with the next version and the generated changelog, without anyone assembling either by hand

#### Scenario: The release pull request is merged
- **WHEN** that release pull request is merged
- **THEN** the tag and GitHub Release are created, and the package is published to the registry from that exact tag

#### Scenario: The release commit is verified before publication
- **WHEN** the publish job runs against the release tag
- **THEN** it re-runs lint, typecheck, and test against that commit before publishing, rather than assuming CI's result on the pre-release commit still holds

#### Scenario: Publishing credentials
- **WHEN** the package is published
- **THEN** authentication SHALL use registry OIDC trusted publishing rather than a long-lived token stored as a repository secret
