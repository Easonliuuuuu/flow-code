## Why

Archiving a change renames its directory to `YYYY-MM-DD-<name>`, but `docs/product/coverage.yaml` keys changes by directory name. If the entry is not moved from `changes:` to `archived:` under the new name, `scripts/status.mjs` resolves the change's `br` to `null` and it **vanishes from its milestone's BR table** — not moved to `archived` beside its neighbours, not flagged, just gone. The `Shipped` line still counts it, so the totals disagree with the tables and neither says why.

`detectDrift` already catches the same mistake on an open change: a `changes:` entry with no `br` produces a finding. The archived loop checks only whether tasks are unchecked. The asymmetry is the whole bug.

`coverage.yaml` states the intended policy directly — *"Unmapped archives are reported, not failed — the ledger postdates them"* — but no such check exists anywhere in `status.mjs`. The behaviour was written down and never implemented, which is how it went unnoticed.

This bit on the very next archive. `route-rejected-gate-to-revision` dropped out of BR-08 and was caught only because a stale `STATUS.md` failed CI for an unrelated reason. Had `STATUS.md` happened to be current, the change would have merged invisible in its own milestone table.

## What Changes

- Add a drift finding for an archived change whose directory name has no entry in `coverage.yaml`'s `archived:` map, mirroring the check that already exists for open changes.
- Make it **fail** rather than merely report. The grandfathering rationale in the file's comment is spent: every archive is mapped as of today, so turning the check on costs nothing and closes the hole permanently.
- Update the `archived:` policy comment, which currently describes a report-not-fail behaviour that does not exist.
- Give the finding a message that names the actual mistake — the entry is probably still in `changes:` under the undated name — rather than only saying the mapping is absent.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-documentation`: the requirement that the generated status view is derived from the repository gains a scenario for an archived change that no business requirement claims, so silent disappearance from a rollup is a failure rather than an absence.

## Impact

- `scripts/status.mjs` — one loop in `detectDrift`.
- `docs/product/coverage.yaml` — the `archived:` policy comment.
- `openspec/specs/project-documentation/spec.md` — one added scenario.
- Possibly `test/` — `scripts/` has no test coverage today; whether this check gets a test is a decision the design records rather than assumes.

No effect on any run. `status:check` already runs in CI, so this strengthens an existing gate rather than adding one.
