## Context

Engine mode expands a graph in two moves. `Engine.run()` stops the instant a
Plan node reaches `done`, returning `{ reason: 'awaiting-expansion', planNodeId }`;
`driveEngine` (`cli/run.ts`) then calls `expandRecordedGraph`, builds a fresh
Engine on the result, and loops. The rebuild itself is already factored out:

```
expandRecordedGraph(workflow, planNodeId, proposal, { repoRoot, skillRoots })
  → buildWorkflowFromRaw(spliceProposal(...)) → { workflow, graph }
```

The reported path shares none of that. `src/guest/validate.ts` checks the Plan
node's output against its declared shape — `nodes[]`, `edges[]` — and
`src/guest/report.ts` writes it to the node's `output` like any other node's.
The graph is never rebuilt, so the proposal is stored and inert.

The two producers differ in shape in a way that matters here. The engine holds
the run open in one process and can afford a stop-rebuild-restart loop. A
reporting surface is the opposite: every report is a read-modify-write against
the document on disk, in a process that exits immediately afterwards, with
nothing carried between calls. There is no loop to re-enter and no live Engine
to rebuild.

## Goals / Non-Goals

**Goals:**

- A reported Plan node's proposal is spliced into the run's recorded graph, and
  its planned nodes become reportable.
- One implementation of the splice, reached from both producers, so a proposal
  cannot be accepted by one and refused by the other.
- A proposal that does not build is refused at report time, leaving the run
  where it was so the guest can propose again.
- Both reporting surfaces tell the guest what the run holds afterwards.

**Non-Goals:**

- Changing engine-mode behavior. `driveEngine` keeps its loop.
- The post-run offer to keep the negotiated graph (`stripPlanNode`,
  `writeKeptWorkflow`). That is an interactive step at the end of `flow-code
  run`, and a reporting surface has no equivalent moment to offer it in.
- Making the Plan node interactive on this path. The engine's Plan node
  negotiates with the user through flow-code's own UI; on the reported path the
  negotiation already happens in the host session, in front of the same person.
  What is missing is the splice, not the conversation.
- Any change to enforcement. An expansion does not raise or lower a tier.

## Decisions

**Call `expandRecordedGraph`, do not reimplement it.** It is already the whole
rebuild, and it already takes exactly the arguments the guest path has. The
alternative — a guest-side splice reusing only `spliceProposal` — would leave
two callers deciding separately how to build and record the result, which is
where the engine and the guest would silently diverge on skill resolution or
validation.

**Expand inside the same read-modify-write that records the node.** The report
handler already loads the document, applies the transition, and persists it.
The rebuild goes between "transition validated" and "persist", so a run is
never on disk with a Plan node `done` and an unexpanded graph. A second process
reading mid-write sees the old state or the new one, never a torn one.

**Refuse rather than record when the proposal does not build.** Engine mode
already treats an invalid proposal as a repair loop: the Plan node reproposes
and nothing is spliced. The reported equivalent of "repropose" is "the report
failed and the node is still `running`", so a refusal must leave run-state
untouched. Building the graph before writing anything gives that for free, and
the build is what produces the message — including the gate-dominance failure,
which is the one an agent-authored proposal is most likely to trip.

**Return the run's node ids on success.** After an expansion the guest's brief
is stale by construction: it was generated from `workflow.yaml`, which does not
contain the proposed nodes. It cannot re-read instructions to discover them,
and asking it to remember what it proposed is asking it to be the authority on
run-state, which it is not. Returning the list is the smallest thing that keeps
the run self-describing.

**Say nothing about expansion in a brief for a graph that cannot expand.** The
instructions are generated per-workflow; a fixed graph gains nothing from a
paragraph about a node type it does not contain, and every added paragraph
competes for attention with the ones that matter.

## Risks / Trade-offs

**A proposal that builds but plans badly** → Not addressed, and deliberately.
Validation answers "is this a legal graph", not "is this a good plan". The gate
dominance rule is the one structural guarantee that must hold, and it does,
because it is enforced at build time by the same check both paths run.

**The guest reports against a node it invented rather than one it proposed** →
Already covered: an unknown node id is rejected by existing validation, and
after expansion the set of known ids is exactly the rebuilt graph's.

**Two writers racing on one document** → Unchanged from today. Guest writes are
already ownership-checked per write, and the expansion happens inside one such
write rather than adding a second.

**Instructions and run drift further apart** → This makes an existing gap
visible rather than creating one: a brief has always described the graph at
generation time. Returning the node list is the mitigation; a fuller answer
(regenerating the brief on expansion) is deliberately not attempted here.

## Open Questions

- Should `flow-code node current` also print the graph's shape rather than only
  the node list, now that the shape can change mid-run? Answerable after the
  reporting surfaces land, and does not block them.
