# Roadmap

> **Status: draft, inferred.** The milestones and their ordering are a reading of
> what the repo is already doing — six archived changes, two open ones, and the
> sequencing argument stated in the guest-mode proposal. The *priorities* are
> genuinely yours and I cannot infer them. Rewrite freely.

This file is **hand-written**. It holds intent: what you are trying to achieve
and how you will know you got there. It deliberately holds no status — status is
derived from the repo into `STATUS.md`, because a status column you maintain by
hand is a status column that lies.

## How to read this

- **Milestone** — a coherent step change in what the product can claim.
- **BR-XX** — a business requirement: an outcome, not a task. If you can close it
  by writing code without anything being different for a user, it is not a BR.
- **Success signal** — how you know it is done, phrased so someone else could
  check it.

BRs map to OpenSpec changes in `docs/product/coverage.yaml`. That mapping is
what lets `STATUS.md` show progress per milestone instead of per directory.

---

## M1 — Ship-ready

*Someone who is not you can install it and get a good first run.* The code is
largely there; this milestone is about the surface around it.

### BR-01 — A stranger succeeds on their first run

Someone who has never seen flow-code installs it, runs `init` then `run` on
their own repository, and gets a working graph without reading source.

**Success signal:** a first run on an unfamiliar repo completes without the user
opening `src/`, and every prompt during `init` is answerable without guessing.

**Second-audience signal:** every prompt and every node label is answerable by
someone who does not read code. If understanding a question requires reading the
diff it is about, it fails this — for both audiences, but only one of them can
work around it.

### BR-02 — The project's quality bar enforces itself

Lint, types, tests, and generated docs are checked automatically, and a release
goes out without hand-assembled steps.

**Success signal:** CI is the only gate anyone needs to trust; a release is one
merge.

---

## M2 — Driver mode is trustworthy

*The graph is right, and it is right under conditions you did not plan for.*
This milestone is the stated precondition for M3: guest mode adds a second
producer of run-state and doubles the surface any run-state bug appears on, so
it should not start until this is solid.

### BR-03 — Watch mode is specified and reliable

`flow-code watch` is a real, documented capability rather than an undocumented
command — read-only viewing, run attachment, and driver liveness are written
down and covered.

**Success signal:** watch has capability spec coverage, and attaching to a live
run from a second window is a tested path rather than a demo.

### BR-04 — Run-state survives real conditions

The run-state document holds up under interruption, concurrency, and processes
that die badly, with ownership explicit rather than incidental.

**Success signal:** killing the engine mid-node leaves a run-state document that
watch can still open and describe honestly.

### BR-05 — The canvas stays legible on real graphs

Panning, zoom, collapsing, and off-screen indication hold up on graphs larger
and busier than the scaffolded default.

**Success signal:** a graph well past the default size is navigable without the
user losing track of where they are.

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
