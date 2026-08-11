## Why

`run-state` already requires that exactly one process writes a run document, but nothing enforces it: `RunStateStore` stamps `process.pid` at construction and never checks it again, `FileRunStatePersister` writes unconditionally, and the only thing keeping a viewer from writing back is that `applySnapshot` deliberately skips the persister. That is a convention holding up a requirement — it works because there is exactly one writer today, and it stops working the moment there is a second one.

That second writer is the whole of BR-06. `add-guest-mode-reporter` is parked on precisely this: its task 1.2 asks for ownership to be explicit and checked, and its design names ownership as "the one place where two writers could genuinely corrupt each other." So this change is not general hardening — it is the specific work standing between the product and the host-agent plugin.

BR-04's success signal is also not met yet in the honest sense. A run killed with `SIGKILL` leaves a document a reader opens fine, but the reader decides whether it is live by asking whether a pid exists — a question that answers wrongly when the pid has been recycled, and that is meaningless when the document was written on another machine over a shared checkout. Both cases are already documented in comments as known lies. A viewer that says "no longer being driven" about a live run, or "running" about a dead one, is exactly the frozen-graph failure BR-03 and BR-04 exist to prevent.

## What Changes

- **Ownership is recorded as an identity, not a pid.** A run document records enough to say *which process on which machine* owns it — host identity plus a process identity that does not survive that process — so a recycled pid is not mistaken for the original owner and a document written elsewhere is recognized as not locally checkable.
- **Ownership is checked before every write, not assumed by construction.** A writer that does not own a run is refused at the persistence boundary, so single-writer becomes a precondition of writing rather than a property of there only being one writer so far.
- **Ownership transfers explicitly.** `--resume` legitimately continues a run under its original id from a new process; that is an ownership handover and is recorded as one, rather than a silent overwrite of the previous owner's stamp.
- **Liveness becomes three-valued: live, dead, or unknowable.** The unknowable case — a foreign host, or a pid that cannot be attributed to the original process — is reported as unknown rather than collapsed into either answer. **BREAKING** for consumers of the current boolean, all of which are in this repo.
- **A run that died badly says so.** A document left behind by a process that was killed without running its shutdown path is distinguishable from one interrupted cleanly and from one still going, and a reader can describe which it is.
- **Concurrent runs in one repo are unambiguous.** A reader attaching without an explicit run id gets a defined answer when two runs are live, instead of following whichever file was written most recently and flipping between them.
- **A crash mid-write leaves the previous document intact.** Already true by tmp-then-rename; it becomes a stated requirement with a test rather than an implementation detail that a future refactor could quietly drop.

## Capabilities

### New Capabilities

None. This sharpens requirements the `run-state` capability already claims rather than adding a new area of behavior.

### Modified Capabilities

- `run-state`: the single-writer requirement gains enforcement and an explicit handover path; liveness becomes three-valued with an unknowable case; a badly-killed run becomes distinguishable from a clean interruption; a reader attaching without a run id gets a defined answer when several runs are live.
- `session-status-line`: the strip must not report "driver gone" when liveness is unknowable — the same rule that already governs its token accounting, applied to the claim it makes about whether a run is still moving.

## Impact

- **`src/runstate/store.ts`**: ownership recorded at construction and on resume; the constructor's `pid: process.pid` becomes an owner identity. `applySnapshot` keeps bypassing the persister — that stays the reader's guarantee, now alongside a check rather than instead of one.
- **`src/runstate/persist.ts`**: `FileRunStatePersister.persist` gains an ownership precondition; `pidAlive` grows into the three-valued liveness check. Both are used by `flow-code runs`, `watch`, `doctor`, and `status`, so the change surfaces at every reader.
- **`src/runstate/watch.ts`**: `isDriverAlive` returns the three-valued result; `newestRunFile`'s mtime heuristic gains a defined behavior when several runs are live.
- **`src/cli/`**: `runs`, `watch`, `doctor`, and `status` each render the third liveness state rather than folding it into one of the other two. `doctor`'s orphaned-worktree reclamation reads liveness to decide what is safe to remove, so an unknowable answer must not be treated as dead there.
- **Run document format**: additive fields. Documents written before this change carry no owner identity and SHALL be readable — their liveness is unknowable by construction, which is the honest answer for them.
- **Unblocks `add-guest-mode-reporter`** (task 1.2, and the ownership precondition its guest writer depends on). It does not implement any part of that change: no second writer is introduced here.
- **Not affected**: `src/engine/`, `src/harness/`, `src/executors/`. This is the storage boundary only.
