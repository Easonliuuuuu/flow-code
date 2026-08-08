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
| `coverage.yaml` | you | The ledger: scope/module → capability, change → BR, and accepted gaps. |
| `../../STATUS.md` | **generated** | Where things actually are. Never hand-edit. |

The rule that keeps this alive: **you write intent, the script derives reality.**
No file here asks you to hand-maintain a fact that git already knows. A status
column you update by hand is a status column that lies, and lying is worse than
absent.

## The three kinds of drift

Only two can be automated. Pretending otherwise is how this rots.

**A. Shipped but never specced** — automated. `npm run status:check` reads every
`feat(<scope>):` commit and every top-level module under `src/`, and fails on
any that no capability spec owns.

**B. Specced but never shipped** — partly automated. The check catches changes
archived with unchecked tasks, and warns about open changes that have gone
quiet. It does *not* verify that a written requirement has code satisfying it —
that needs requirements to name their tests, which is deliberately deferred.

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
those took one edit, no `openspec/changes/` directory. `flow-code watch`, by
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
