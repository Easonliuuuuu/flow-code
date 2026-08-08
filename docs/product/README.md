# The product layer

OpenSpec tracks *changes*. This directory tracks *why they exist* and catches
the ones that never got tracked at all.

## The problem it solves

Two failures that OpenSpec alone cannot catch:

1. **Work drifts from intent.** Every proposal justifies itself in its own "Why"
   section. That is local reasoning — there is nothing above the change to check
   it against, so nothing catches work that is well-built but off-goal.
2. **Work ships without ever entering OpenSpec.** A small feature lands
   directly; a feature you meant to build is quietly forgotten. Both are
   invisible to a system whose only inputs are the changes you remembered to
   write.

## The layout

| File | Written by | Holds |
| --- | --- | --- |
| `brief.md` | you | What flow-code is, who for, what it is not. Stable. |
| `roadmap.md` | you | Milestones and business requirements (`BR-XX`) — outcomes, no status. |
| `inbox.md` | you | Anything you don't want to lose. One line, no ceremony. |
| `coverage.yaml` | you | The ledger: scope/module → capability → BR, change → BR, and accepted gaps. |
| `../../STATUS.md` | **generated** | Where things actually are. Never hand-edit. |

The rule that keeps this alive: **you write intent, the script derives reality.**
No file here asks you to hand-maintain a fact that git already knows. A status
column you update by hand is a status column that lies, and lying is worse than
absent.

## The chain: BR → ER → spec

A business requirement (`roadmap.md`) is an outcome. A capability
(`openspec/specs/<name>/spec.md`) is the engineering requirement that outcome
is built from — it already has the right vocabulary, `### Requirement:` and
`#### Scenario:` blocks. There is no separate ER document; the capability spec
*is* the ER. What was missing until this was added was the edge connecting the
two.

`coverage.yaml`'s `capabilities:` map is that edge: exactly one BR per
capability. Not a list — a strict tree. Many capabilities can serve the same
BR, but a single capability claiming two BRs is usually a sign it should split
into two capabilities, not that the map should hold an array. `status:check`
fails on a capability with no BR and on a BR id that doesn't exist in
`roadmap.md`, the same way it fails on an unmapped scope or module.

It also walks that edge **backwards**, which catches the quieter failure. A
capability nobody asked for announces itself — the code is there, the check
trips. A requirement nobody is serving announces nothing: it shows up as a
milestone bar that never moves, and only if someone happens to look at the bar.
So a BR with nothing attached to it is a finding too.

"Attached" is wider than the capability map on purpose. A BR counts as served
if a capability maps to it, *or* an open or archived change targets it, *or* a
registered gap names it in `tracked_by`. That last one matters: re-reporting a
BR whose gap you already wrote down would punish the person who did the honest
thing. What the check is looking for is a BR reached by none of the three —
intent with no thread of any kind leading back to it.

This is what makes a standalone small feature traceable without extra
bookkeeping. `presets` (see below) has no OpenSpec change of its own — it maps
straight to `workflow-graph`'s `spec.md`. Because `workflow-graph` maps to
BR-08 in `capabilities:`, `presets` inherits that link automatically. It does
not need its own BR, and nobody has to remember to give it one.

The full chain, in order, with the change process as an optional detour:

```
BR (roadmap.md)
  → capability / ER (openspec/specs/<name>/spec.md)
      → Requirement + Scenario (the spec itself, always present)
      → OpenSpec change (openspec/changes/, only for work that needed
        planning — proposal.md + design.md + tasks.md, archived once done)
```

Doing this mapping once surfaced something worth knowing rather than hiding:
three shipped, spec'd capabilities — `node-skills`, `node-subagents`,
`worktree-agent-node` — fit no BR then in `roadmap.md`. Forcing them under
BR-01 to make the check quiet would have made 8 of the 9 capabilities point at
one BR, which would have stopped meaning much, so they were registered as gaps
(GAP-07/08/09) instead. That was roadmap incompleteness, not code drift, and
the system could tell the two apart.

They are now closed. The roadmap review that followed found all three serve one
outcome nobody had written down — BR-07, *a node can gain capability without the
run losing its boundaries* — and mapped them to it. Worth keeping as the worked
example of the intended lifecycle: a gap is raised because the roadmap is
incomplete, and it closes when the roadmap stops being incomplete. A gap that
gets renewed instead of resolved is the failure mode.

The same review is why the capability map is also a **BR quality check**, not
only a traceability edge. Counting capabilities per BR tells you something the
BR's own wording hides: one to three is healthy; five is the top of the range;
more than that, or a count that doesn't match what the BR's label claims, means
the BR has quietly become a bucket. BR-01 owning five capabilities is what
showed it had drifted from "a stranger's first run" into "the product exists."

## The three kinds of drift

Only two can be automated. Pretending otherwise is how this rots.

**A. Shipped but never specced** — automated. `npm run status:check` reads every
`feat(<scope>):` commit and every top-level module under `src/`, and fails on
any that no capability spec owns.

**B. Specced but never shipped** — partly automated. The check catches changes
archived with unchecked tasks, warns about open changes that have gone quiet,
and fails on a BR nothing is attached to. It does *not* verify that a written
requirement has code satisfying it — that needs requirements to name their
tests, which is deliberately deferred.

There is a fourth thing that looks like a new kind and isn't: a change that
**shipped and was never archived**. `wire-up-cicd-and-readme` sat at 0/13 in
`STATUS.md` for six days while CI, the README, `CONTRIBUTING.md`, and
release-please had all shipped, because task checkboxes are a hand-maintained
status column and the unchecked-task rule only applies to *archived* changes.
That is kind B seen from the other side, not a fifth column in this table. The
detector that covers it is the staleness warning — which is time-based and
advisory by design, so it tells you a change has gone quiet, never why. Nothing
short of comparing a change's spec deltas against the repo would catch it
properly, and that is not worth building. Archiving promptly is the fix.

**C. Never written down at all** — impossible to automate. No script finds the
feature that only ever existed in your head during a prompt. `inbox.md` is the
entire mitigation, and it works only because capture costs one line.

`flow-code watch` was a C→A failure worth remembering: it *was* captured, in the
guest-mode proposal's Impact section, where nothing looks. Capture into
`inbox.md`, not into prose.

## The ratchet

`coverage.yaml` has a `registered_gaps` section. A gap listed there is debt you
have already seen and decided about, so the check stays green — which is what
lets it go into CI today rather than after a cleanup sprint. Anything
*unregistered* fails. Known debt is visible; new debt is blocked.

Every gap needs a `tracked_by` (a BR or `inbox`). A gap tracked by nothing is
just a silenced alarm, and the check says so.

One shape to watch: a `kind: br` gap cannot be tracked by the BR it is about.
`tracked_by: BR-01` on a gap whose whole subject is that nothing serves BR-01
points at itself and tracks nothing, while still reading as green. Those go to
`inbox`, where a human has to triage them.

## Not every feature earns a full OpenSpec change

A `spec.md` under `openspec/specs/` is markdown: `### Requirement:` and
`#### Scenario:` blocks. You can edit it directly. A full OpenSpec change
(`openspec/changes/<name>/proposal.md` + `design.md` + `tasks.md`) is a
heavier process on top of that, meant for work that needs planning before it's
built — a new capability, something cross-cutting, a design worth debating.

Most drift the check finds is not that. Forcing a small feature through the
full change process just to satisfy `status:check` would make the check itself
the thing driving unnecessary ceremony — exactly what it exists to prevent
elsewhere.

The rule: **if the feature already shipped and is small, add the requirement
directly to the owning capability's `spec.md` — no change proposal.** If it's
large enough that you'd genuinely want to plan it before touching code, it
earns the full process, whether or not the code already exists.

`presets` is the worked example. Three `feat(presets)` commits, 232 lines,
composes existing node types and "adds no registry surface" by its own doc
comment — small. `workflow-graph/spec.md` already had a `Workflow presets`
requirement; it was just missing scenarios for what had actually shipped
(the spec-kit preset, the CLI-install offer, the skill-scaffold offer). Adding
those took one edit, no `openspec/changes/` directory, and no BR of its own —
it inherits BR-08 through `workflow-graph` in `capabilities:` (see above).
`flow-code watch`, by
contrast, is staying a `registered_gaps` entry until M2 — a new command with
its own UI, run-attachment, and liveness model is exactly the kind of thing
worth planning before writing the spec, not after.

`registered_gaps` is for genuinely undecided or deliberately deferred work —
not a place to leave something just because writing it up felt like too much
process. If the honest fix is a five-line spec edit, do that instead of
registering a gap.

## Working with it

```bash
npm run status         # regenerate STATUS.md
npm run status:check   # fail if STATUS.md is stale or drift is unregistered (CI runs this)
```

**`status:check` needs full git history.** The commit-scope pass reads every
`feat()` commit, so a shallow clone would see part of history and pass green
having verified almost nothing. It refuses to run rather than report a success
it cannot back up — `git fetch --unshallow` if you hit that. CI checks out with
`fetch-depth: 0` for the same reason.

This is not hypothetical: the check's own first CI run caught six scopes that a
shallow local clone had hidden, after the guard had been warning about it into a
suppressed stderr stream the whole time.

When the check fails on a scope or module, you have three honest options, in
order of preference:

1. **Write the spec.** The feature deserves one — as a direct `spec.md` edit if
   it's small, as a full change proposal if it needs planning. See below.
2. **Map it** in `coverage.yaml` — an existing capability already covers it.
3. **Register it** as a gap, with a reason and a `tracked_by`. You have looked
   at it and decided later.

What you should not do is widen a mapping until the warning disappears. The
ledger is a statement of ownership, and a mapping that claims a capability
covers something it does not is the same lie the check exists to prevent.

When it fails on a **BR** instead, the options invert — the code is not the
problem, the requirement is unattached. Write the capability spec that would
satisfy it, open a change for it, or register it as a `kind: br` gap saying why
not yet. Pointing an existing capability at it to clear the error is the same
mistake as widening a mapping, one level up.
