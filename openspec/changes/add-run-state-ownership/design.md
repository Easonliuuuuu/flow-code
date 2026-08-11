## Context

`RunStateStore` (`src/runstate/store.ts`) stamps `pid: process.pid` into the document at construction and never revisits it. `FileRunStatePersister` (`src/runstate/persist.ts`) writes the whole document with tmp-then-rename on every mutation, unconditionally. `applySnapshot` is the reader's path and deliberately skips the persister, with a comment explaining that a viewer writing back "could resurrect state the run had already moved past."

So the single-writer property currently rests on one thing: there is only one writer. The `run-state` spec already *requires* the property ("One writer owns a run document"), which means the requirement is true today by circumstance rather than by construction. `add-guest-mode-reporter` is parked partly on this, and its design says so directly: ownership is "the one place where two writers could genuinely corrupt each other, so it is enforced rather than documented."

Liveness has the same shape of problem. `pidAlive` and `isDriverAlive` both carry comments admitting what they cannot know — pids are recycled, and a pid means nothing when the document was written on another machine over a shared checkout. Every reader (`runs`, `watch`, `doctor`, `status`) turns that into a two-valued answer anyway, which means each of them states, confidently, something it does not know.

Two facts shape the design. First, this is coordination between cooperating processes, not a security boundary — nothing here needs to survive a process that is actively trying to lie. Second, `--resume` continues a run under its original id from a new process, so ownership is legitimately transferable and any design that treats the first owner as permanent breaks resume.

## Goals / Non-Goals

**Goals:**
- Make single-writer a precondition checked at the point of writing, not a property of there being one writer.
- Let a reader distinguish "the driver is alive", "the driver is gone", and "I cannot know from here", and never present the third as either of the first two.
- Keep `--resume` working by making ownership handover an explicit, recorded act.
- Give a reader attaching without a run id a defined answer when several runs are live.
- Keep run documents written before this change readable, with an honest liveness answer for them.
- Leave the guest write path exactly as parked — this change introduces no second writer.

**Non-Goals:**
- File locking. Rejected in `add-guest-mode-reporter`'s design as heavier than needed and badly behaved across the network mounts this feature is most likely to span; nothing here revisits that.
- Ownership as a security boundary. A process that forges an owner identity is out of scope; the concern is two cooperating writers corrupting each other by accident.
- Heartbeats or any periodic write. See Decisions.
- Implementing guest-mode reporting, or any part of `add-guest-mode-reporter` beyond the precondition its task 1.2 depends on.

## Decisions

**Ownership is proven by a token; liveness is estimated from pid and host.** The writer generates a random token per store instance and records it in the document; it holds the same token in memory. "Is this document still mine?" is then an exact comparison, not an inference. A *reader* cannot use the token — there is nothing to compare it against — so liveness stays a pid question, narrowed by also recording which host wrote it. The split is the point: the writer gets certainty about ownership, the reader gets a bounded estimate about liveness, and neither pretends to the other's answer. *Alternative considered:* pid plus process start time, which makes recycled pids detectable by a reader too. Rejected for now — it means parsing `/proc/<pid>/stat` on Linux and shelling to `ps` elsewhere, a platform dependency in a module that currently has none, for a case the `unknown` state already reports honestly.

**Writes are gated by a stat, not by a re-read.** The persister records the mtime of what it last wrote. Before writing again it stats the file: unchanged means we are still the only writer and the write proceeds; changed means someone else has written since, so the persister re-reads, compares owner tokens, and refuses if the document is no longer ours. Cost in the common case is one `stat` per write rather than a full read-parse. *Alternative considered:* verifying ownership only when the persister is attached. Rejected — that catches the case where a second writer starts later than us, which is precisely the case guest mode introduces.

**Refusing a write is loud and terminal for that writer.** A persister that discovers it no longer owns the document stops writing and surfaces an error rather than dropping the write silently or continuing in memory. A run whose state has stopped being recorded is worse than a run that fails, because the graph keeps looking right.

**Liveness is a three-valued result, typed so call sites cannot ignore the third case.** `live` when the recorded host matches this one and the pid exists; `dead` when the host matches and it does not; `unknown` when the host differs, the identity is absent (a document written before this change), or the pid is unusable. Returning a union rather than a boolean makes every existing call site a compile error until it says what it does with `unknown` — which is the point, since each one currently answers a question it cannot. *Alternative considered:* keep the boolean and treat `unknown` as `dead`. Rejected: `doctor` reclaims worktrees from runs it believes are dead, and "I cannot tell" must never authorize deletion.

**No heartbeat.** A recycled pid on the same host still reads as `live`, and a heartbeat would narrow it. But a heartbeat means writing while idle, and it makes a slow node indistinguishable from a dead driver whenever the interval is tuned wrong — turning a rare wrong answer into a routine one. A Discuss node can legitimately sit silent for as long as the user takes to reply. The residual case stays documented rather than traded for a worse one.

**A badly-killed run needs no new field.** A run interrupted cleanly already records `finishedAt` with `interrupted: true`, because the signal handler runs. A `SIGKILL` records neither. So "died without finishing" is exactly *unfinished, plus an owner that is not alive* — derivable the moment liveness is trustworthy, which is what the rest of this change delivers. The work here is that readers describe it, not that anything new is written. *Alternative considered:* a shutdown marker written on start and cleared on exit. Rejected as redundant with the pid we already have.

**A reader with no run id must not silently choose between live runs.** `newestRunFile` picks by mtime, which is right when one run is being written and arbitrary when two are. The rule becomes: attach to the single live run when there is exactly one; when there are several, report that rather than picking. Readers with room (`watch`, `runs`) name them; a reader with one row (`status`) indicates that there is more than one. *Alternative considered:* always pick the newest and say nothing. Rejected — it is the flipping-viewer bug, and it is worse in a strip than in a window because there is no visible run id to notice the flip by.

**Atomic replacement becomes a requirement with a test.** Tmp-then-rename already gives it; writing it down means a future refactor that "simplifies" to a direct write fails a test rather than silently reintroducing torn documents.

## Risks / Trade-offs

- **The stat check has a time-of-check/time-of-use window** → Accepted and stated: this coordinates cooperating processes, and the window is narrower than the failure it replaces (no check at all). It is not a locking primitive and must not be described as one.
- **Hostname is not a stable machine identity** — containers, DHCP renames, two checkouts on hosts that share a name → All failure modes push toward `unknown`, which is the safe direction. Named as an open question, since a stable machine id would tighten it.
- **A recycled pid on the same host still reads as `live`** → Unfixed, deliberately, per the no-heartbeat decision. Documented where the liveness type is defined so the next person weighing a heartbeat finds the reasoning rather than re-deriving it.
- **Three-valued liveness touches every reader** → Wide but mechanical, and the type makes the compiler enumerate the work. The risk is a call site that maps `unknown` to whichever branch is convenient; the spec pins the two cases where that would matter (worktree reclamation, and any claim that a run is no longer moving).
- **Every pre-existing run document becomes `unknown`** → Correct, and it will look like a regression in `flow-code runs` output for old runs. Mitigated by rendering `unknown` as its own state rather than as an error, and by the fact that a finished run's liveness is not interesting anyway.

## Migration Plan

Additive fields on the run document; older readers ignore them and newer readers treat their absence as `unknown`. No command changes behavior except in what it reports about liveness. Rollback is reverting the code — documents written with owner identities stay readable, since the fields are additive and nothing else keys off them.

Sequencing: this lands before any part of `add-guest-mode-reporter`, which is the change that makes a second writer real. Nothing here needs to wait on that change, and it should not be built speculatively toward it beyond the precondition itself.

## Open Questions

- Is hostname enough to scope pid liveness, or should the owner identity carry a stable machine id (`/etc/machine-id` on Linux, the platform equivalent elsewhere)? Hostname is free and portable; a machine id is right more often and costs a platform branch.
- Should `doctor` treat worktrees belonging to an `unknown` run as reclaimable behind an explicit confirmation, or refuse them outright? Refusing is safe and leaves debris on a shared checkout forever.
- Does the strip need to indicate multiple live runs at all, given it has one row and no space for a run id? Possibly the honest minimum there is a marker, with `flow-code runs` as the place that names them.
