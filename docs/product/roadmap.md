# Roadmap

> **Restructured after review.** The first version of this file was inferred from
> the repo and said so. This one is a decision: BR-03 and BR-05 were rewritten
> because they described a remedy and a mechanism rather than an outcome, BR-07 /
> BR-08 / BR-09 were added for shipped work that no requirement claimed, and M0
> was added because most of the product was built before this file existed.
> One decision is deliberately still open — see `inbox.md`.

This file is **hand-written**. It holds intent: what you are trying to achieve
and how you will know you got there. It deliberately holds no status — status is
derived from the repo into `STATUS.md`, because a status column you maintain by
hand is a status column that lies.

## How to read this

- **Milestone** — a coherent step change in what the product can claim.
- **BR-XX** — a business requirement: an outcome, not a task. If you can close it
  by writing code without anything being different for a user, it is not a BR.
- **Success signal** — how you know it is done, phrased so someone else could
  check it *without you in the room*. If two people could reasonably disagree
  about whether it passed, it needs a number or a named task in it.

Three rules that keep this file from rotting:

1. **No mechanism in the body.** A BR that names pan/zoom, or worktrees, or a
   file format, is a design decision wearing a BR's clothes — replacing the
   mechanism would not change the outcome. Mechanism belongs in the capability
   spec.
2. **No remedy as an outcome.** "X is documented" or "X is specified" is how you
   get somewhere, not somewhere to get to. Nobody's run improves because a file
   exists.
3. **Ids are stable labels, not an ordering.** M0 holding BR-07/08/09 is not a
   mistake. Ids are never renumbered or reused, because git history, the ledger,
   and past discussion all refer to them.

Guiding constraints live in `brief.md`, not here. They are invariants that apply
to every BR at once — no change is allowed to violate them, so no single BR owns
them.

BRs map to capabilities and to OpenSpec changes in `docs/product/coverage.yaml`.
That mapping is what lets `STATUS.md` show progress per milestone instead of per
directory. It is also the best diagnostic this file has: if one BR owns five or
more capabilities, check that the label really covers all of them rather than
having quietly become a bucket.

---

## M0 — The core run works

*Shipped.* Recorded because the roadmap was written after most of this was
built, and a milestone that exists only in git history is a milestone nothing can
be checked against. Its three requirements are what the six archived changes
actually delivered.

### BR-08 — A run does what the graph says it does

The graph on screen is the authority on what executes. Nodes run as declared, a
failing verdict is a fact rather than a model's opinion, the model you picked is
the model that runs, and nothing reaches git without an explicit approval.

**Success signal:** for any finished run, every claim the graph made can be
confirmed from outside the tool — the commands that ran, the model each node
used, and the absence of any commit nobody approved.

### BR-09 — A run is legible without reading a transcript

Someone looking at the screen can say where the run is, what it has cost so far,
and what it is about to do next, without scrolling through output.

**Success signal:** a person who did not start the run can answer those three
questions from one screen, and be right.

**Second-audience signal:** the answers carry the same meaning for someone who
will never open the file. A node reading `done` means done, not "the agent
stopped."

### BR-07 — A node can gain capability without the run losing its boundaries

A node's agent can be extended with a skill, delegate to a subagent, or work in
an isolated tree — and none of that moves work outside the node's budget, its
capability envelope, or what its card reports.

**Success signal:** for each of the three, a node using it is indistinguishable
in *kind* from one that does not — same budget arithmetic, same permission
envelope, same approval path. Nothing escapes the node by being delegated or
isolated.

---

## M1 — Ship-ready

*Someone who is not you can install it and get a good first run.* The code is
largely there; this milestone is about the surface around it.

### BR-01 — A stranger succeeds on their first run

Someone who has never seen flow-code installs it from a package registry, runs
`init` then `run` on their own repository, and gets a working graph without
reading source.

**Success signal:** on a machine that has never had this repo checked out,
install → `init` → `run` completes without the user opening `src/`, and every
prompt during `init` is answerable without guessing.

**Second-audience signal:** every prompt and every node label is answerable by
someone who does not read code. If understanding a question requires reading the
diff it is about, it fails this — for both audiences, but only one of them can
work around it.

### BR-02 — The project's quality bar enforces itself

> *Internal.* The beneficiary here is whoever maintains this, not a user. It is
> kept deliberately — the honesty of every other requirement rests on the checks
> that guard it — but it is the one BR in this file that is not a model for the
> others.

Lint, types, tests, generated docs, and the product ledger are all checked
automatically, and a release goes out without hand-assembled steps.

**Success signal:** CI is the only gate anyone needs to trust; a release is one
merge.

---

## M2 — Driver mode is trustworthy

*The graph is right, and it is right under conditions you did not plan for.*
This milestone is the stated precondition for M3: guest mode adds a second
producer of run-state and doubles the surface any run-state bug appears on, so
it should not start until this is solid.

### BR-03 — A second window can watch a live run without disturbing it

You can open a run that is already going from another terminal, see it update as
it goes, and be unable to affect it by accident.

**Success signal:** with a run in progress, a second window attaches and reflects
node state changes as they happen; nothing done in that window alters the run;
and when the driving process dies, the viewer says so rather than showing a
frozen graph as though it were live.

### BR-04 — Run-state survives real conditions

The run-state document holds up under interruption, concurrency, and processes
that die badly, with ownership explicit rather than incidental.

**Success signal:** killing the engine mid-node leaves a run-state document that
watch can still open and describe honestly.

### BR-05 — A graph bigger than the default stays navigable

On graphs several times the size of the scaffolded default, you can still find a
specific node and tell where it sits in the run.

**Success signal:** on a 40-node graph, someone who did not build it can find and
open a named node without using search, and say what is upstream of it.

---

## M3 — Meet users in the CLI they already use

*Stop asking people to give up their agent to get the graph.* The whole
switching cost that makes flow-code read as "another agent CLI" lives here.

### BR-06 — An external agent can drive the graph

A host agent (`claude`, `codex`, `opencode`) reports its progress, and the
viewer lights up beside it — with the reduced guarantees stated plainly rather
than papered over.

**Success signal:** a user runs their own agent, watches the graph fill in, and
the UI is explicit about what a guest run does not enforce.

---

## Parked

Work that is designed but deliberately not scheduled. Parked is a decision;
it is tracked so it stays distinguishable from forgotten.

- **`add-guest-mode-reporter`** (BR-06) — design captured while the reasoning
  was fresh. Blocked on M2 by the author's own argument, not by capacity.
