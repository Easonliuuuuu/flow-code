## Why

The engine already resolves a model per node (`config.model ?? settings.model`), and every agent-driven node type already accepts an optional `model` in its config schema — but nothing in the running UI can set it. Choosing a cheap model for Review and a strong one for Implement means quitting the run, hand-editing `.flow-code/workflow.yaml`, and starting over, so in practice every node runs on the one project-wide model picked at `flow-code init`. The canvas already tracks a focused node and renders its detail view; it just cannot edit the single field with the largest effect on a run's cost and quality.

## What Changes

- Add a **model picker** to the run UI, opened with `m` on the focused node. Mouse click on a node's model badge is an alias for the same action — the picker is fully operable from the keyboard, matching the existing mouse-as-enhancement rule.
- The picker lists the models available for the **project's configured provider**, reusing the model list and selection list already built for the `flow-code init` wizard.
- A selection is written back to `.flow-code/workflow.yaml` as that node's `config.model`, **preserving comments, key order, and formatting** — the file is checked in and hand-edited, so a round-trip that reformats it is not acceptable.
- The selection also applies to the **current run** for any node that has not started yet. A node that is already `running` or `done` shows its model read-only, with the picker stating that a change applies on re-run rather than silently accepting one that does nothing.
- A node box carries a **model badge** when its effective model differs from `settings.model`, so a per-node override is visible on the graph without expanding anything.
- Nodes with no model (Test, Approval-Gate) reject the picker with a brief status message instead of opening an empty list.
- **Out of scope: per-node provider.** The engine takes a single `SessionRunner`, and stored credentials hold one provider. Per-node provider needs a runner per node, multi-provider credentials, and preflight validation per node — a separate change, deliberately not bundled here.

## Capabilities

### New Capabilities
- `node-model-selection`: choosing an agent-driven node's model from the running UI, how that choice resolves against the run-wide default, when it takes effect relative to node status, and how it is persisted back to the workflow file without disturbing the user's formatting.

### Modified Capabilities
- `terminal-canvas-ui`: the keyboard-first navigation requirement enumerates the node interactions reachable by keyboard alone (expand, approve, reject) and gains the model picker; the mouse-enhancement requirement currently states that changes made in the UI are not written back to the workflow file, which must be narrowed to node positions now that a model choice is persisted.

## Impact

- `src/ui/App.tsx`: picker mode, `m` key binding, click target on the badge, and applying a pending selection to the current run.
- `src/ui/canvas.ts`: the per-node model badge.
- New workflow writer module: an in-place `config.model` edit on `.flow-code/workflow.yaml` via the `yaml` package's Document AST (already a dependency), preserving comments.
- `src/init/SelectList.tsx`, `src/init/modelList.ts`: reused by the picker; may need extracting out of `init/` if the coupling to the wizard is awkward.
- `src/engine/*`, `src/registry/index.ts`, `src/executors/helpers.ts`: **unchanged** — `model?: string` and `nodeModel()` already do the right thing.
- Tests: workflow-writer round-trip (comments and unrelated keys survive), picker geometry/state in `test/ui.test.ts`, and an end-to-end render test in `test/app.render.test.ts`.
