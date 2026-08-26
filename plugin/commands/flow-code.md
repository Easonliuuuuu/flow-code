---
description: Walk this project's flow-code graph for the task described, reporting each step
argument-hint: [what you want done]
---

Walk this project's flow-code graph for the following task:

$ARGUMENTS

Start by calling `describe_workflow` to read the steps this project has — do not
assume a shape. If it reports no workflow file exists yet, discuss with the user
what they want: a one-off preset for just this run (name it straight to
`describe_workflow`/`open_run`), or the project's own persistent workflow — run
`flow-code init` yourself (via Bash; add `--preset <name>` for a named preset,
or leave it bare for the default graph) to scaffold it, then retry
`describe_workflow`. Do not tell the user to run it themselves.

Then `open_run`, and work through the steps in order, calling
`start_node` before each one. Keep interactive `discuss` and `plan` steps in this
conversation. For Plan, use `propose_plan`, revise as needed, and use `accept_plan`
only after you have shown the returned proposed graph (its nodes and edges) and the
user explicitly agrees; use `complete_node` (or `fail_node`) for the other steps.
At an approval gate, show the user the actual diff and/or document it's gating on —
it arrives in the gate's brief but the user hasn't seen it until you say it — before
asking for their decision. If that gate sits above a `git-ops` step, draft the commit
message from the diff, show it in the same message, and hand the approved text to
`git-ops`'s subagent verbatim. Close the run when you are done.

If `git-ops` committed anything, ask afterwards (outside the graph) whether the user
wants a pull request; if so, draft its title and body, show them, and only run
`gh pr create` once the user explicitly approves.

If a report is rejected, the reason names what is unsatisfied: fix the sequence
rather than reporting something else. If the graph declares a return path from a
failing step, walk it yourself — nothing routes you back.

Tell the user they can watch this with `flow-code watch` in another terminal.
