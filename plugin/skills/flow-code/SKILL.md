---
name: flow-code
description: >-
  Walk this project's flow-code graph and report each step, so the run shows up in
  the flow-code viewer instead of only in the transcript. Use whenever you start a
  coding task in a repository that has a .flow-code/workflow.yaml.
---

# Walking a flow-code graph

Some repositories describe their work as a graph of steps — discuss, implement, test,
review — instead of leaving it to be improvised per task. This skill is how you walk
one and make the run visible to whoever is watching it.

Nothing here is project-specific on purpose. **The graph is per-project, and
`describe_workflow` is the only place it is described.** Do not assume a shape.

## Do this

1. **`describe_workflow`** — read the steps this project actually has, what each one
   must produce, and any return paths. Do this before anything else.
2. **`open_run`** — opens the run and returns the step ids in order.
3. For each step, in order:
   - **`start_node`** *before* you begin the work.
   - Do the work.
   - **`complete_node`** with that step's output, in the shape `describe_workflow`
     gave for it — or **`fail_node`** with a reason if it did not succeed.
4. **`close_run`** when the graph is finished, or when you are stopping early.

If you lose your place, **`run_status`** lists every step and where it stands.

## Things that trip people up

**Report before you work, not after.** A run reported in one burst at the end is a
record, not something anyone could have watched. The point of the graph is that a
second window shows what is happening *while* it happens.

**A rejected report means the sequence is wrong, not the tool.** Every transition is
checked against the graph: a step cannot start before the steps above it are done,
and cannot complete without having started. The rejection names what is unsatisfied.
Read it and fix the order — do not report something else instead.

**Return paths are yours to walk.** If `describe_workflow` shows a return path (test
back to implement, say), nothing routes you back along it. Report the failure, then
report the earlier step started again yourself.

**An approval gate is a question for the user.** Stop and ask them directly. Never
decide one yourself, and never report it complete on their behalf.

## What this does not do

flow-code is not executing you here. It validates the order of what you report and
records it; it does not restrict which tools you use, choose your model, or count
your tokens. Runs opened this way are recorded at the `reported` tier and labelled
that way wherever they are displayed — a green graph is a record of what you said,
not evidence that anything was checked.
