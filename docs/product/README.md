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

## Working with it

```bash
npm run status         # regenerate STATUS.md
npm run status:check   # fail if STATUS.md is stale or drift is unregistered (CI runs this)
```

When the check fails on a scope or module, you have three honest options, in
order of preference:

1. **Write the spec.** The feature deserves one.
2. **Map it** in `coverage.yaml` — an existing capability already covers it.
3. **Register it** as a gap, with a reason and a `tracked_by`. You have looked
   at it and decided later.

What you should not do is widen a mapping until the warning disappears. The
ledger is a statement of ownership, and a mapping that claims a capability
covers something it does not is the same lie the check exists to prevent.
