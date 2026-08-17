## Context

`scripts/status.mjs` derives `STATUS.md` from the repository and refuses to let hand-written claims into it. Its `detectDrift` pass collects `findings`, and `--check` exits non-zero if any exist. The ledger it reads, `docs/product/coverage.yaml`, holds three maps keyed by name: `capabilities:`, `changes:`, and `archived:`.

The relevant code is a two-line asymmetry:

```js
// open changes — flags a missing br
for (const change of changes) {
  if (!change.br) findings.push({ kind: 'change', ... });
}

// archived changes — checks task counts only
for (const change of archived) {
  if (change.total > 0 && change.done < change.total) findings.push({ kind: 'archive', ... });
}
```

`readArchived` already computes `br: archivedMeta[name] ?? null`, so the value the check needs is present and simply unread.

The consequence is not a missing warning. `render` builds each BR table from changes whose `br` matches, so a `null` drops the row entirely — the change disappears from the milestone it belongs to while `Shipped` keeps counting it. The rollup goes quietly wrong rather than visibly incomplete, which is the exact failure mode this file exists to prevent.

Two facts shape the fix. The file's comment says *"Unmapped archives are reported, not failed — the ledger postdates them"*, describing behaviour that was never implemented. And that rationale is now spent: every archive in the repository is mapped today, so nothing is grandfathered by leaving the check off.

## Goals / Non-Goals

**Goals:**

- An archived change with no BR attribution produces a finding, the same way an open one does.
- The finding names the likely cause — a `changes:` entry left behind under the pre-archive name — not just the symptom.
- The `archived:` comment describes what the code does.
- The check is proven to fire, not merely written.

**Non-Goals:**

- Not inferring the BR by stripping the date prefix and looking the change up in `changes:`. Discussed below and rejected.
- Not automating the `changes:` → `archived:` move. Attribution at archive time is a decision worth making deliberately; the guard exists so that forgetting is loud, not so it becomes unnecessary.
- Not changing how `render` builds BR tables. A dropped row is a symptom; the fix belongs at the check.
- Not restructuring `coverage.yaml`'s three-map shape.

## Decisions

**Fail rather than report.** Every finding in `detectDrift` already fails `--check`; a "report but do not fail" tier does not exist and inventing one for this case would be the only soft finding in the file. The comment's rationale was grandfathering pre-ledger archives, and there are none left. Turning it on today costs nothing and is the only version that actually holds.

*Alternative considered:* add a `warnings` entry instead — `status.mjs` has that channel and it does not fail. Rejected: a warning that appears on every CI run until someone fixes it is training to ignore warnings, and this one is silent-corruption-shaped, not advisory.

**Do not auto-resolve the BR from the undated name.** `2026-08-17-route-rejected-gate-to-revision` could be stripped to `route-rejected-gate-to-revision` and looked up in `changes:`, making the archive step self-healing. Rejected for two reasons: it makes the ledger's two maps silently overlap, so `changes:` would keep stale entries that still resolve; and archive-time attribution is a real judgment call — `coverage.yaml`'s own header spends three paragraphs on changes that spanned more than one BR and records which one was chosen and why. Deriving it would erase that.

**Reuse the `archive` finding kind.** The existing archived-with-unchecked-tasks finding already uses `kind: 'archive'`. A second condition under the same kind keeps the output grouped by where the reader must look.

**Test it.** `scripts/` has no test coverage at all today — no test file references `status.mjs` or `detectDrift`. That is defensible for a generator whose output is itself checked into the repo and diffed by CI, but not for a guard: an unwritten guard and a broken guard fail identically, which is precisely how the current bug survived. The design's position is that this change adds the first test for `status.mjs`, exercising `--check` against a fixture ledger with one unmapped archive. If that proves disproportionate once the script's structure is examined — it is a top-level script with module-level file reads, not an importable unit — the fallback is a task that manually removes the `2026-08-17` entry, confirms `status:check` fails with the new message, and restores it. That is weaker, and the task list should say so rather than quietly settle for it.

## Risks / Trade-offs

**`status.mjs` may not be importable for a test** → Its ledger paths are resolved at module load, so testing may require running it as a subprocess against a fixture repo rather than importing `detectDrift`. Establish which is feasible before writing the test, and prefer the subprocess form over refactoring the script — a refactor to enable one test is a larger change than the guard it protects.

**The check fires on a legitimately unattributable archive** → Nothing in the repository is in that state today. If one arises, `registered_gaps` is the existing escape hatch and needs no new mechanism.

**The message misdiagnoses** → An archive can be unmapped because the entry was left in `changes:` under the old name, or because it was never mapped at all. The first is overwhelmingly likelier at archive time. Word it to name that case as the probable cause without asserting it, so the reader is not sent looking for an entry that was never written.

**Fixing the symptom instead** → Making `render` show unattributed archives in some "no BR" bucket would make the disappearance visible without requiring attribution. That is a worse outcome: it normalizes unattributed archives instead of preventing them, and BR-02's claim is that the ledger maps shipped work to product intent.
