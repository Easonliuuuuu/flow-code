## 1. Owner identity

- [x] 1.1 Record an owner identity on the run document: the writing process, the machine it is on, and a token the writer holds in memory and can compare exactly
- [x] 1.2 Generate the identity where the run is constructed, and keep it out of the paths that only read
- [x] 1.3 Test a document written before owner identities existed still parses, and reports its driver status as unknowable

## 2. Enforced single writer

- [x] 2.1 Gate every write on ownership at the persistence boundary: stat-compare against what this writer last wrote, and re-read to compare owner tokens only when something else has written since
- [x] 2.2 Refuse a write whose owner token does not match, leaving the document byte-identical
- [x] 2.3 Surface a refused write as a failure rather than dropping it or continuing in memory
- [x] 2.4 Test a second writer against a run it does not own is refused and changes nothing
- [x] 2.5 Test a writer that owned the document and then lost ownership is refused on its next write
- [x] 2.6 Test the common-path cost is one stat per write, not a read-and-parse

## 3. Ownership transfer

- [x] 3.1 Take ownership on resume as an explicit act, recording that a transfer occurred and who held it before
- [x] 3.2 Refuse to resume a run whose recorded owner is still alive, reporting that it is already being driven
- [x] 3.3 Test resume of a run whose owner is gone succeeds and its subsequent writes are accepted
- [x] 3.4 Test resume of a live run is refused and the live run's document is untouched

## 4. Three-valued liveness

- [x] 4.1 Replace the boolean liveness check with a result carrying live, not alive, and unknowable, typed so no call site can silently keep its old two-way branch
- [x] 4.2 Return unknowable for a document recorded on another machine, and for one with no owner identity
- [x] 4.3 Document, where the type is defined, that a recycled pid on the same machine still reads as live, and why a heartbeat was rejected rather than fixing it
- [x] 4.4 Update every reader — the run listing, the viewer, the doctor, the status line — to render the third state as itself
- [x] 4.5 Ensure worktree reclamation never treats an unknowable run as abandoned
- [x] 4.6 Test each of the three results is produced by the condition that should produce it

## 5. Describing how a run ended

- [x] 5.1 Describe an unfinished run whose owner is not alive as having stopped without finishing, distinctly from a clean interruption
- [x] 5.2 Keep a cleanly interrupted run resumable and described as interrupted
- [x] 5.3 Test a run whose process is killed outright is described as stopped-without-finishing by every reader, and that its document still parses

## 6. Attaching without a run id

- [x] 6.1 Attach to the single live run when exactly one is live
- [x] 6.2 Report the ambiguity when several runs are live, naming the candidates in readers that have room and indicating the count in the status line
- [x] 6.3 Attach to the most recent run when none is live, without presenting it as being driven
- [x] 6.4 Test all three cases, including that a viewer does not alternate between two live runs across refreshes

## 7. Atomic replacement

- [x] 7.1 State the atomic-replacement guarantee where the persister is defined, so a later simplification to a direct write is visibly a regression
- [x] 7.2 Test a write interrupted partway leaves the previously published document parseable and complete
- [x] 7.3 Test no reader ever observes the published path in a partially written state

## 8. Documentation

- [x] 8.1 Document the three liveness states in the README where runs and watching are described, including what unknowable means and when it happens
- [x] 8.2 Note in `add-guest-mode-reporter`'s tasks that its ownership prerequisite is now satisfied, and by which requirement
