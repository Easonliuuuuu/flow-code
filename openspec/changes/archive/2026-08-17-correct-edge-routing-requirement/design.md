## Context

`edgeSchema` in `src/workflow/schema.ts` is a `strictObject` over four fields: `from`, `to`, `loopback` (itself `{ maxAttempts, on }`), and `when`. The spec's `Edges carry no behavior` requirement names the first three and omits the fourth, then adds a scenario requiring the loader to reject anything it did not name.

The omission is not an oversight about one field. It reflects a principle the project genuinely held at the time — edges are inert, all behaviour lives in nodes — that the codebase has since refined rather than abandoned. Two things happened to it:

- **Routing conditions** gave an edge a say in *whether a path carries*. `when:` is evaluated at load time and its target is skipped when it does not hold.
- **`loopback.on`** gave a return path a say in *which outcome takes it*, added by `route-rejected-gate-to-revision`. That change updated the schema and the loop-back requirement but not this scenario's property list, so `on` is unnamed here too.

What did *not* change is the part the original principle was actually protecting: an edge cannot declare that its source passed or failed. `Verification types declare a failure predicate` and `An edge cannot decide success or failure` both still hold, and `route-rejected-gate-to-revision` reaffirmed it explicitly — its `A loop-back declares which outcome takes it` requirement says *"Whether a node succeeded or failed SHALL remain the node type's call; the edge only says where each outcome routes."*

So the correction is not "edges may now carry behaviour." It is that the original requirement drew its line in the wrong place, and the codebase has been drawing it correctly for some time without the spec catching up.

## Goals / Non-Goals

**Goals:**

- State the line the code actually enforces: an edge routes, a node type judges.
- Make `Unrecognized edge property` match `edgeSchema`'s real field set, so the scenario is a true statement about the loader.
- Fix the `src/workflow/schema.ts:102` doc comment carrying the same stale framing.
- Leave the codebase's genuine invariant no weaker than it is today.

**Non-Goals:**

- No behaviour change. If a test needs editing, the change has overreached — that is the signal to stop and re-read.
- Not adding, removing, or renaming any edge field.
- Not revisiting whether routing conditions were a good idea. They shipped; this change describes them.
- Not touching the two gate-conditioning requirements below it, which are correct as written.

## Decisions

**Rename the requirement rather than patch it in place.** "Edges carry no behavior" is the part that is wrong; leaving the title while correcting the body would preserve the misleading thing a reader skims. Proposed: `Edges route, node types judge`. The replacement has to be a real claim, not a hedge — "edges carry limited behavior" would describe nothing and forbid nothing.

*Alternative considered:* keep the title and add a carve-out paragraph for `when`. Rejected — it accumulates exceptions around a rule that is simply mis-stated, and the next edge field repeats the argument.

**Enumerate the recognized fields from `edgeSchema`, not from memory.** The scenario's list has now drifted twice (`when`, then `loopback.on`). Writing it against the actual `strictObject` fields is what makes it a checkable statement rather than a second place to keep in sync by hand.

**Keep `An edge cannot decide success or failure` untouched.** It is the surviving half of the original principle and the thing the rewrite is organized around. Restating it in new words risks weakening it by accident, and it is already phrased well.

**Treat the code comment as part of the same correction.** `src/workflow/schema.ts:102` says "Edges declare structure, never behavior" eight lines above the `when:` field whose own comment describes routing. A reader hitting that file sees the contradiction faster than one reading the spec. Fixing one without the other leaves the drift, just relocated.

## Risks / Trade-offs

**The rewrite loosens the rule further than the code does** → The specific thing to preserve is that no edge field may determine its source's verdict. Check the new wording against `An edge cannot decide success or failure` and against `A loop-back declares which outcome takes it`; if the three do not agree, the new one is wrong. `docs/product/coverage.yaml` records node-type-owns-its-verdict as a standing commitment, so this is not a local style question.

**Scope creep into behaviour** → The tell is a failing test. `npm test` should pass untouched at every point in this change; nothing in `src/` changes but a comment.

**The scenario drifts a third time** → This change fixes the two known omissions but adds no mechanism preventing a fourth field from being added without updating the list. Out of scope here, and worth noting rather than solving: the general problem is the same one `status:check` solves for the ledger, and a spec-to-schema check is a much larger idea than this correction should carry.
