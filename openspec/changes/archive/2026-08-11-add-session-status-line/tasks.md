## 1. Summary model

- [x] 1.1 Derive a summary from a `RunState`: the node that most needs attention (waiting, then running, then error), completion count, spend, and the run's enforcement tier when it is not engine-driven
- [x] 1.2 Reuse the existing liveness interpretation to report an unfinished run whose driver is gone as no longer driven, rather than as running
- [x] 1.3 Render spend as unavailable, never as zero, for a run whose tier provides no token accounting
- [x] 1.4 Test the headline resolves waiting over running over error, and reports a finished run as finished rather than naming a node
- [x] 1.5 Test an interrupted run is distinguishable from a completed one

## 2. Width ladder

- [x] 2.1 Render the labelled form, the indicator-only form, and the blocking-node-only form, selected by available width
- [x] 2.2 Measure and truncate in display columns via `src/ui/textwrap.ts`, not string length
- [x] 2.3 Never wrap to an extra row when constrained
- [x] 2.4 Test each rung fits its width exactly, including node ids containing wide characters
- [x] 2.5 Test the blocking node's name and reason survive to the narrowest rung

## 3. Command surface

- [x] 3.1 Add the `flow-code status` subcommand: human-readable by default, `--line` emitting one embeddable segment
- [x] 3.2 Accept the width to render for, defaulting to the terminal's when there is one
- [x] 3.3 Render the idle summary and exit zero when no run exists, when the run document is unreadable, or when it is mid-write
- [x] 3.4 Test the command performs no writes — the run document and the runs directory are byte-identical after repeated invocations against a live run
- [x] 3.5 Test a truncated or malformed run document renders idle rather than erroring, and is never reported as partial run state

## 4. Attention transitions

- [x] 4.1 Report a node entering `waiting` or `error` as an announceable transition, given the previously announced state
- [x] 4.2 Announce a given transition once rather than on every subsequent check
- [x] 4.3 Test that a run sitting in `waiting` across many checks announces once, and that a new waiting node announces again

## 5. Provision for a surface with none

- [x] 5.1 Provide a complete status output for a user with no existing status surface, without making it the assumed integration path
- [x] 5.2 Document embedding the segment into an existing status surface, and the cost of adopting a full one where the host suppresses its own hints in exchange

## 6. Documentation

- [x] 6.1 Document `flow-code status` in the README beside `watch`: what it answers, what it deliberately does not show, and that it works against a run driven by anything
- [x] 6.2 State that the strip is a pointer to the canvas rather than a replacement for it
