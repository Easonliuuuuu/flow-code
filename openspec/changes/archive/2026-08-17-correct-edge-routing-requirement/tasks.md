## 1. Establish the baseline before changing anything

- [x] 1.1 Confirm the delta's property list matches `edgeSchema` in `src/workflow/schema.ts` field for field: `from`, `to`, `loopback` (`maxAttempts`, `on`), `when`. If a field has been added since this change was written, the delta is already stale — fix it here rather than after applying.
- [x] 1.2 Run `npm test` and record that it passes. This change must leave that unchanged; a failure at the end is the signal it overreached into behaviour.

## 2. Correct the requirement

- [x] 2.1 Apply the delta to `openspec/specs/workflow-graph/spec.md`: rename `Edges carry no behavior` to `Edges route, node types judge` and replace its body and scenarios with the delta's.
- [x] 2.2 Confirm `An edge cannot decide success or failure` survives the rewrite word for word. It is the half of the original principle that is still true, and restating it risks weakening it by accident.
- [x] 2.3 Read the rewritten requirement against `A loop-back declares which outcome takes it` further down the same file. Both say the node type owns the verdict; if they now disagree in wording or force, the new one is wrong.
- [x] 2.4 Check the two gate-conditioning requirements immediately below (`Unconditional edges out of an Approval-Gate are conditioned on approval`, `A loop-back declares which outcome takes it`) still read coherently after their neighbour changed. They were correct as written and should need no edit — confirm that rather than assume it.

## 3. Correct the code comment

- [x] 3.1 Rewrite the `edgeSchema` doc comment at `src/workflow/schema.ts:102`, which opens "Edges declare structure, never behavior" eight lines above the `when:` field it contradicts. State the routing-versus-judging line instead.
- [x] 3.2 Leave the `when:` field's own comment alone — it already describes routing correctly and is what makes the contradiction visible.
- [x] 3.3 Grep for the same stale framing elsewhere (`docs/workflow-reference.md`, `src/workflow/load.ts`, `src/defaultWorkflow.ts`) and fix any other place that says edges carry only structure. Report what was found even if nothing was.

## 4. Verify

- [x] 4.1 Run `openspec validate --all --strict`.
- [x] 4.2 Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run docs:check`. Tests must pass with no test file edited — if one needed changing, stop and re-read the design's non-goals.
- [x] 4.3 Run `npm run status` and confirm the only diff is this change's own row.
