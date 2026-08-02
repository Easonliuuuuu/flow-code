## 1. Workflow file writer

- [x] 1.1 Add `src/workflow/write.ts` with `setNodeModel(path, nodeId, model | null)`: re-read the file, edit `nodes[<id>].config.model` via the `yaml` package's `parseDocument`/`setIn`/`deleteIn`, and write via temp file + rename
- [x] 1.2 Create the `config` mapping when the node entry has none, and delete `config.model` (and the now-empty `config` mapping) when passed `null`
- [x] 1.3 Re-validate the edited document through `loadWorkflowFromString` before writing, throwing without touching the file if it would no longer load
- [x] 1.4 Test the round-trip against `DEFAULT_WORKFLOW_YAML`: comments, blank lines, key order, and every other node survive byte-for-byte, only the target value changes (one documented gap: a dangling trailing comment with no following node loses its separating blank line — a `yaml` library limitation, noted in `write.ts` and covered by its own test)
- [x] 1.5 Test the no-`config` node, the delete path, the unknown-node-id error, and that a write failure leaves the original file intact

## 2. Model resolution and provenance

- [x] 2.1 Capture the workflow's own `settings.model` in `cmdRun` before the credentials fallback overwrites it, and pass it plus the provider default and provider id into `runUi`
- [x] 2.2 Add a pure `resolveNodeModel(nodeConfig, workflowSettingsModel, providerDefaultModel)` returning the model and its origin (`node` | `settings` | `provider`)
- [x] 2.3 Unit-test the three-level fallback and each origin value, including the case where all three are absent

## 3. Model list for the run UI

- [x] 3.1 Add a run-scoped loader around `fetchModelIds` that reads the API key from `process.env[providerInfo(provider).apiKeyEnvVar]` and caches the result (including the failure) for the life of the run
- [x] 3.2 Expose loading / loaded / failed states so the picker can open immediately and fill in later, never blocking Ink's input loop
- [x] 3.3 Test that the loader fetches at most once per run and that a failure surfaces its error message rather than throwing

## 4. Picker UI

- [x] 4.1 Reuse `SelectList`'s scrolling math (`windowFor`, imported from `src/init/SelectList.ts`) rather than mounting the component itself — `SelectList` owns its own `useInput`, and stacking a second live `useInput` hook on top of `App`'s single central dispatch would double-handle every keypress while the picker is open. The list is instead rendered inline, cursor-driven from `App`'s own dispatch, matching how Convergence selection already works. The wizard's `SelectList`/`selectFromList` are untouched.
- [x] 4.2 Add a picker mode to `App.tsx` opened by `m` on the focused node, rendered in the existing status panel so it inherits move/resize/dock
- [x] 4.3 Mark the node's currently resolved model as selected; support confirm, dismiss-without-change, and free-text entry when the model list failed to load
- [x] 4.4 Decline with a status message on a node type that runs no agent session, and when no provider could be resolved
- [x] 4.5 Show the model read-only for a `running` or `done` node, stating that a change applies on re-run
- [x] 4.6 On confirm: write the file via `setNodeModel`, mutate the pending node's in-memory `config.model` for the current run, and report a write failure in the UI without interrupting the run

## 5. Visibility on the graph

- [x] 5.1 Render a model badge on a node box whose resolved model differs from the run-wide default, truncated to the box width (shares the box's one badge slot with the `↻N` retry badge; retry wins on the rare collision — see design.md addendum)
- [x] 5.2 Name the resolved model and its origin in the node detail view
- [x] 5.3 Make the badge a click target that opens the picker, leaving the rest of the box a position-drag handle
- [x] 5.4 Test badge presence/absence against the resolution rules in `test/ui.test.ts`

## 6. End-to-end verification

- [x] 6.1 Add an `app.render.test.ts` case: open the picker with `m`, choose a model, and assert the badge appears and the workflow file on disk carries the new `config.model` (landed as its own file, `test/app.modelPicker.test.ts`, to keep the discuss-panel and model-picker fixtures separate)
- [x] 6.2 Add a case asserting the picker is read-only on a `done` node and that dismissing leaves the file untouched
- [x] 6.3 Run `npm test`, `npm run lint`, `npm run typecheck` — 267/267 passed (3 full runs to rule out the flakiness fixed below), lint and typecheck clean. Mid-run pickup on a real agent session (spending real provider tokens) is not exercised here; `test/app.modelPicker.test.ts` covers the same write-then-in-memory-mutate path end-to-end against the real App, and `test/e2e.test.ts` already proves the engine reads `node.config` fresh at node-start time for loop-back re-runs — worth one live check next time a run reaches a model-bearing node before/while it's pending.
- [x] 6.4 Document the per-node model override and the picker key in `README.md`
