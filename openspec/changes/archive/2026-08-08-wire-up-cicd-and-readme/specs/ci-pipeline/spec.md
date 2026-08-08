## ADDED Requirements

### Requirement: CI runs on pull requests targeting main
The system SHALL run a GitHub Actions workflow on every pull request that targets the `main` branch.

#### Scenario: PR opened against main
- **WHEN** a pull request is opened or updated targeting `main`
- **THEN** the CI workflow runs and reports its status on the pull request

### Requirement: CI runs on pushes to main
The system SHALL run the same GitHub Actions workflow on every push to `main`, independent of whether the push came through a merged pull request or a direct push.

#### Scenario: Direct push to main
- **WHEN** a commit is pushed directly to `main`
- **THEN** the CI workflow runs and reports pass/fail status for that commit

### Requirement: CI checks install, lint, typecheck, and test
The CI workflow SHALL install dependencies and run the project's lint, typecheck, and test scripts, failing the run if any step fails.

#### Scenario: All checks pass
- **WHEN** the workflow runs `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run test` and all four succeed
- **THEN** the workflow reports an overall success status

#### Scenario: A check fails
- **WHEN** any of `npm run lint`, `npm run typecheck`, or `npm run test` exits non-zero
- **THEN** the workflow reports an overall failure status and stops before running later steps

### Requirement: CI targets the engines floor, not the latest Node version
The CI workflow SHALL run against the Node.js major version declared as the floor in `package.json`'s `engines.node` field, not an unpinned "latest" version.

#### Scenario: engines floor is Node 20
- **WHEN** `package.json` declares `"engines": { "node": ">=20" }`
- **THEN** the CI workflow's runner is configured to use Node 20.x

### Requirement: CI does not publish or release
The CI workflow SHALL be limited to verification (install, lint, typecheck, test) and SHALL NOT publish a package to any registry or create a GitHub release.

#### Scenario: Workflow run completes
- **WHEN** the CI workflow finishes, regardless of pass or fail
- **THEN** no package is published and no release/tag is created as a side effect
