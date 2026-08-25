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
If the user explicitly asks for a named preset such as OpenSpec or SpecKit,
pass that preset to `describe_workflow` and `open_run`; do not open the project's
default workflow first.

## Do this

1. **`describe_workflow`** — read the steps this project actually has, what each one
   must produce, and any return paths. If the user selected a preset, pass its name.
   Do this before anything else.
2. **`open_run`** — opens the selected project workflow or preset and returns the step ids in order.
3. For each step, in order:
   - **`start_node`** *before* you begin the work. It returns that step's brief.
   - For an interactive `discuss` or `plan` step, stay in this user-facing conversation and
     talk with the user. Do not delegate the conversation to a fresh subagent.
   - For every non-interactive step, **run it in a fresh subagent**, handing it the brief
     verbatim. Do not do that work in this conversation — see below.
   - **`complete_node`** with that step's output, in the shape `describe_workflow`
     gave for it — or **`fail_node`** with a reason if it did not succeed.
   - For a `plan` step, call **`propose_plan`** after drafting the graph, revise it as needed,
     and call **`accept_plan`** only after the user explicitly accepts it. Do not use
     `complete_node` for Plan.
4. If the graph has an approval gate, **ask the user** and record their answer with
   **`decide_gate`**. Never decide one yourself.
5. **`close_run`** when the graph is finished, or when you are stopping early.

## Why each step gets its own subagent

A graph whose steps all share one context window is not a graph — it is a checklist. If
you implement the code and then "review" it in the same conversation, the reviewer is the
author, and it will find what the author already believes. That is the specific failure
this whole structure exists to prevent, and running each step in a subagent with only its
brief is what prevents it. `node_brief` re-reads a brief if you lose one.

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

**An approval gate is a question for the user.** Stop and ask them directly, then record
their answer with `decide_gate`. `complete_node` refuses approval gates outright, so
there is no path where you can answer one on their behalf.

## What is enforced, and what is not

While a step is in progress, your tool calls are checked against that step's capability
set and denied if they fall outside it — a review step cannot edit files, and nothing can
write to the repository while an approval gate above it is unanswered. **A denial is the
boundary working, not a bug.** Do not route around it, and do not report a step complete
that you were prevented from doing.

Not enforced, because flow-code did not start your session: which model you run on, what
the session costs, the directory and environment you run in, which subagent types you have
available to delegate to, and routing you back along a return path. A run records the
`hooks` tier only when the enforcement layer is verified to be running; otherwise it
records `reported`, and is labelled that way wherever it is shown.

A subagent you spawn is not outside the boundary: its calls are checked against the same
step's capability set, so a subagent running the review step cannot edit either.
