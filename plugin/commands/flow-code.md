---
description: Walk this project's flow-code graph for the task described, reporting each step
argument-hint: [what you want done]
---

Walk this project's flow-code graph for the following task:

$ARGUMENTS

Start by calling `describe_workflow` to read the steps this project has — do not
assume a shape. Then `open_run`, and work through the steps in order, calling
`start_node` before each one. Keep interactive `discuss` and `plan` steps in this
conversation. For Plan, use `propose_plan`, revise as needed, and use `accept_plan`
only after you have shown the returned proposed graph (its nodes and edges) and the
user explicitly agrees; use `complete_node` (or `fail_node`) for the other steps.
Close the run when you are done.

If a report is rejected, the reason names what is unsatisfied: fix the sequence
rather than reporting something else. If the graph declares a return path from a
failing step, walk it yourself — nothing routes you back.

Tell the user they can watch this with `flow-code watch` in another terminal.
