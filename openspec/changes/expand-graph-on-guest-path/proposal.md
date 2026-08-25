## Why

A Plan node negotiates a graph and its proposal is spliced into the run, so the
work it planned actually has nodes to run in. That splice lives in
`Engine.run()` and `driveEngine` (`cli/run.ts`) — engine mode only. On the
reported path a host agent can report a Plan node complete, have the proposal
accepted and stored in the node's output, and get back a run whose graph never
changed: the nodes it just planned do not exist, and there is nothing to report
against.

Nothing fails. The report is legal, the node reaches `done`, and the run
continues to whatever the Plan node's successors already were. That silence is
the problem — the one shape of run flow-code offers for "I don't know what this
task needs yet" is the one that quietly does nothing when driven from the agent
the user already runs, which is now the path the product leads with.

## What Changes

- A reported Plan node's proposal is spliced into the run's recorded graph, the
  same rebuild engine mode performs, so its planned nodes exist and can be
  reported against.
- The splice moves behind one shared entry point used by both producers, so the
  two paths cannot drift into accepting different proposals.
- A proposal that fails to build a valid graph is refused at report time with
  the same message engine mode reports, rather than being stored as output and
  discovered later as a run with nowhere to go.
- Reporting surfaces (`flow-code node done`, the MCP tool) tell the agent which
  nodes the run now has, since the nodes it may report next are ones that did
  not exist when it was briefed.
- Guest instructions describe the expansion step for a graph containing a Plan
  node, which today's generated brief has no way to mention.

## Capabilities

### New Capabilities

_None._ This adds no capability; it makes an existing one reachable from a
second producer.

### Modified Capabilities

- `guest-run-reporting`: reporting a Plan node complete now rebuilds the run's
  graph from its proposal, and refuses a proposal that does not build. Today
  the requirement covers recording output only.
- `guest-agent-instructions`: the generated brief must describe what happens
  when a Plan node completes — that the graph grows, and that the nodes to
  report next come from the run rather than from the brief.

## Impact

- `src/guest/report.ts`, `src/guest/validate.ts` — accept, validate and apply a
  proposal on the reported path.
- `src/workflow/splice.ts`, `src/workflow/record.ts` — `spliceProposal` and
  `expandRecordedGraph` become shared rather than engine-only callers.
- `src/guest/instructions.ts` — brief the expansion.
- `src/guest/mcp.ts`, `src/cli/node.ts` — report the post-expansion node list.
- `docs/agent-integration.md` — enforcement tiers table gains the expansion
  step; a `hooks`-tier run that expands is still a `hooks`-tier run.
- No engine-mode behavior changes. `driveEngine` keeps its loop; the shared
  entry point is the code beneath it.
