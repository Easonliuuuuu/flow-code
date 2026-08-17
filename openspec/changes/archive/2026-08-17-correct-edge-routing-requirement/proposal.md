## Why

`workflow-graph`'s "Edges carry no behavior" requirement says an edge declares only `from`, `to`, and its loop-back declaration. Edge routing conditions have existed since edge conditions shipped, and the same spec file relies on them further down — "Independent structural failures" describes validation catching *"an edge condition reading a node it cannot see"*. So the file both forbids and depends on the same field.

The requirement's `Unrecognized edge property` scenario is the sharp end: read literally, it requires the loader to reject any edge carrying a `when:`, which is the opposite of what `edgeSchema` does. A spec that contradicts shipped behaviour is worse than a missing one, because it is the thing a reader trusts when the code surprises them.

This surfaced while archiving `route-rejected-gate-to-revision`, which added two gate-conditioning requirements immediately below the stale one. The contradiction is now adjacent and unmissable rather than buried.

## What Changes

- Rewrite the `Edges carry no behavior` requirement around the distinction the code actually holds: an edge may **route** — decide whether a path carries — but may not **judge**, because whether a node succeeded is the node type's call.
- Rename the requirement accordingly. "Carry no behavior" was never quite true of loop-backs either, and is now plainly false.
- Admit `when` to the recognized-property list in the `Unrecognized edge property` scenario, alongside the loop-back trigger `on` that `route-rejected-gate-to-revision` added without updating this scenario.
- Keep `An edge cannot decide success or failure` as-is. It is the invariant that survived, and it is what the rewritten requirement is built around.
- Correct the matching doc comment at `src/workflow/schema.ts:102`, which carries the same stale framing ("Edges declare structure, never behavior") directly above the `when:` field it contradicts.

No behaviour change. Nothing in `src/` changes except a comment; no test should need editing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-graph`: the `Edges carry no behavior` requirement is renamed and restated around routing-versus-judging, and its `Unrecognized edge property` scenario is corrected to admit `when` and `loopback.on`.

## Impact

- `openspec/specs/workflow-graph/spec.md` — one requirement renamed and restated, one scenario corrected.
- `src/workflow/schema.ts` — the `edgeSchema` doc comment at :102.

Nothing executable changes. The risk is the reverse of a normal change: the spec must not be written so loosely that it stops forbidding what the codebase still forbids. `An edge cannot decide success or failure` is load-bearing — `docs/product/coverage.yaml` names the node-type-owns-its-verdict rule as a standing design commitment, and BR-08's whole claim is that the graph is the authority on what executes.
