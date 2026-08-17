## 1. Reproduce the bug before fixing it

- [x] 1.1 Temporarily remove `2026-08-17-route-rejected-gate-to-revision` from `coverage.yaml`'s `archived:` map, run `npm run status`, and confirm the row disappears from BR-08 while `Shipped` still counts it — 318/324 against 12 archived changes. Confirm `npm run status:check` reports **no** drift finding for it. That silence is the bug.
- [x] 1.2 Restore the entry. Do not leave the ledger broken between tasks.

## 2. Add the check

- [x] 2.1 In `detectDrift` in `scripts/status.mjs`, add a `!change.br` check to the `for (const change of archived)` loop, mirroring the one the `changes` loop already has. `readArchived` already resolves `br` to `null` when the name is absent, so no new lookup is needed.
- [x] 2.2 Use `kind: 'archive'`, matching the unchecked-tasks finding beside it, so both point the reader at the same place.
- [x] 2.3 Word the message to name the likely cause — the entry is probably still in `changes:` under the pre-archive name — without asserting it, since an archive that was never mapped at all is also possible.
- [x] 2.4 Keep the two archived checks independent. A change can be both unattributed and archived with unchecked boxes, and each should be reported.

## 3. Correct the policy comment

- [x] 3.1 Rewrite the `archived:` comment in `docs/product/coverage.yaml`. It currently says "Unmapped archives are reported, not failed — the ledger postdates them", which describes behaviour that never existed and a grandfathering rationale that is now spent.
- [x] 3.2 State that every archive must be attributed and that an unmapped one fails, and note `registered_gaps` as the escape hatch if one ever genuinely cannot be attributed.
- [x] 3.3 Leave the rest of the header alone — the notes on changes that spanned more than one BR, and on the date prefix meaning archival rather than ship date, are still accurate and are why auto-deriving the BR was rejected.

## 4. Prove the check fires

- [x] 4.1 Establish first whether `scripts/status.mjs` can be exercised from a test at all. Its ledger paths resolve at module load, so importing `detectDrift` may not be possible. Prefer running the script as a subprocess against a fixture ledger over refactoring the script to be importable — a refactor to enable one test is larger than the guard it protects. **Outcome:** paths resolve from `import.meta.url`, so there is no injection point and `detectDrift` cannot be imported in isolation. The subprocess route works: copy the script into a fixture git repo carrying a minimal `coverage.yaml`, `roadmap.md`, one archived change, one spec, and one `src/` module, symlink `node_modules` for the `yaml` import, and run it there. The script was not modified.
- [x] 4.2 If a test is feasible, add one asserting that `--check` exits non-zero and names the change when an archived directory has no `archived:` entry. This would be the first test covering `scripts/`. **Done:** `test/status.drift.test.ts`, four cases — fails and names the change, points at the pre-archive name, passes once attributed, and renders the attributed archive under its requirement rather than dropping it. The last one covers the render-side symptom, not just the finding.
- [x] 4.3 If 4.1 shows a test is disproportionate, say so explicitly in the change rather than going quiet: re-run 1.1 by hand against the finished check, confirm it now fails with the new message, and record in the proposal that this guard rests on a manual verification. Do not leave the reader to infer which of the two happened. **Not taken** — 4.2 produced a real test, so this fallback did not apply. The manual reproduction in 1.1 still ran, and is what the test was written against.

## 5. Verify

- [x] 5.1 Run `npm run status:check` on the intact ledger and confirm it passes — the new check must not fire on a correct repository. **It fired**, on a pre-existing case: `2026-08-10-add-per-task-workflow-graphs` was archived on 2026-08-10 with its ledger entry left in `changes:` under the undated name, so 34 tasks had been missing from BR-08 ever since. Not a false positive — the first real thing the guard found. Moved to `archived:` under its dated name, keeping the BR-08 attribution and its note's reasoning as a comment. Re-run is clean.
- [x] 5.2 Run `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run docs:check`. All pass; 85 files, 1079 tests.
- [x] 5.3 Run `openspec validate --all --strict`. 18/18.
- [x] 5.4 Confirm `STATUS.md` is unchanged by this change apart from its own row. The check adds a finding path; it must not alter what the rollup renders when nothing is wrong. **Deviation, recorded rather than smoothed:** the rollup also gained the `2026-08-10-add-per-task-workflow-graphs` row and its 34 tasks, because 5.1 restored an attribution that had been missing. The render path itself is untouched — the numbers moved because the ledger was corrected, which is the change working as intended rather than an unintended edit.
