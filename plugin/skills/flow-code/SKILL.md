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

Choose the workflow source before calling `describe_workflow` or `open_run`:

- An explicit preset name wins. If the user names two presets, ask which one they want.
- Select `openspec` only when the user names OpenSpec.
- Select `spec-kit` only when the user names Spec Kit, SpecKit, or `spec-kit`.
- Select `frugal` when the user names Frugal. If they only ask to reduce tokens, time,
  or cost, ask whether they want Frugal before opening the run.
- Select `planned` when the user names Planned or asks to create, design, or negotiate
  the graph/workflow for this task, decide the execution steps together, or form the
  graph before coding. A generic request to "plan the implementation" is not enough.
- Otherwise use the project's workflow. A generic request to write a spec does not
  select OpenSpec or Spec Kit.

Pass the selected preset to both `describe_workflow` and `open_run`; do not open the
project's default workflow first and switch afterwards.

If no preset was named and the project has no `.flow-code/workflow.yaml` yet,
`describe_workflow` reports that instead of a graph. Do not tell the user to go
run a command themselves — ask what they want:

- A one-off graph for just this run: use one of the four presets above as a
  per-run override (never written to disk).
- A persistent workflow for this project: run `flow-code init` yourself via
  Bash — bare for the default graph, or `--preset <name>` for a named one —
  then retry `describe_workflow`. On a repo with no workflow file yet this
  writes cleanly with no prompts, so there is nothing to confirm with the user
  first beyond which graph they want.

Whenever `.flow-code/workflow.yaml` exists on disk — it was already there, or
you just scaffolded it with `flow-code init` — also run
`flow-code connect --status-line` via Bash, once, before `open_run`. It installs
only the status-bar row Claude Code's own footer shows (`.claude/settings.json`'s
`statusLine`, plus the script it points at); it does not touch `.mcp.json` or
install any instructions, so it never duplicates what the plugin already
provides, and it's safe to run even if already installed (it no-ops). Skip it
entirely for a one-off preset run with no workflow file — `connect` requires
one on disk and there is nothing to point it at.

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
     and show the returned proposed graph (its nodes and edges) to the user before asking
     whether to accept or revise it. Call **`accept_plan`** only after the user explicitly
     accepts it. Do not use `complete_node` for Plan.
4. If the graph has an approval gate, **show the user what they're deciding on** —
   the diff and/or the document a direct dependency produced (a Spec node's title,
   requirements, and acceptance criteria, say) — before you ask anything. That content
   arrives in the gate's own brief from `start_node`, as upstream output; it does not
   reach the user unless you put it in your reply. If the gate sits directly above a
   `git-ops` step, also draft the commit message from that diff now and show it
   alongside it — one approval covers both the change and how it will be described.
   Then **ask the user** and record their answer with **`decide_gate`**. Never decide
   one yourself.
   - Once approved, when you start the `git-ops` step, hand its subagent the exact
     message the user approved as an explicit instruction ("commit with exactly this
     message") rather than letting it draft its own — the approval was for that text,
     not for whatever the subagent might write instead.
5. **`close_run`** when the graph is finished, or when you are stopping early.
6. If a `git-ops` step in this run committed anything, **ask whether they want a pull
   request** — this is outside the graph entirely, so do it after `close_run`. If yes,
   draft a PR title and body from the commit/diff, show them in full, and only after
   the user approves (editing as needed) push if not already pushed and run
   `gh pr create --title … --body …` via Bash. Never push or open a PR the user didn't
   just ask for, and never open one without showing its content first.

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

**An approval gate is a question for the user, about something they haven't seen yet.**
Having the content in your own context because it arrived in a brief is not the same as
the user having seen it. Paste or summarize the actual diff/document in your reply first,
then stop and ask them directly, then record their answer with `decide_gate`.
`complete_node` refuses approval gates outright, so there is no path where you can answer
one on their behalf.

**A commit message is content too, not a detail `git-ops` sorts out on its own.** Draft
it before the gate that precedes `git-ops`, show it with the diff, and pass the approved
text into the `git-ops` subagent's instructions verbatim. A PR is the same shape of
decision, just after the graph is done: draft it, show it, wait for explicit agreement,
then run `gh pr create`.

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
