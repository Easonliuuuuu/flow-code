## Why

One graph, checked into the repo, runs every task. A typo fix and a risky auth refactor get the same eight nodes and the same amount of verification, so one of them is always wrong — over-processed or under-checked. Letting the process fit the task is the direction, and two things have to be true before any of it can be built.

A graph is only knowable by reading `.flow-code/workflow.yaml`. Nothing can check that file without starting a run, and a run records only node *statuses* — the shape lives outside the run, so `watch` re-loads the file and reconciles against it (`src/runstate/watch.ts:56-73`). Both assumptions break the moment a graph is chosen or composed per task.

This change fixes both, and stops there. It is deliberately additive: nothing about how a run behaves today changes.

## What Changes

- **`flow-code validate`** — a command that loads `.flow-code/workflow.yaml`, runs the existing schema and structural checks against it, and reports every problem it finds with the node id and edge involved, exiting non-zero when any fail. Today the same checks exist but only as a bail-out on the path to `run`, so the only way to learn a hand-edited file is wrong is to start a run and watch it refuse.
- **Validation reports what it could not reach** — the loader is staged (parse → file shape → declarations → structure), so a failure says which checks it stopped, rather than leaving silence to be read as a pass.
- **The run document records its graph** — nodes, edges, node types and resolved config are written into `.flow-code/runs/<runId>.json` alongside the per-node status already there, and a recorded graph can be rebuilt into a runnable workflow through exactly the checks a fresh load uses.

Explicitly *not* in scope, and split into `add-per-task-workflow-graphs`: making `watch` and `--resume` read the recorded graph, keeping it in step with mid-run node edits, and named graphs a run selects among. The first of those turns out to need a design decision about the UI's workflow prop that this change should not make on the way past — see that change's Context.

## Capabilities

### New Capabilities
- `run-state`: the run document — what a run records about itself, and who may write it. Closes GAP-02 and GAP-05, which registered `src/runstate/` as having no owning spec while both `watch` and the parked guest-mode change depend on it.

### Modified Capabilities
- `workflow-graph`: gains a requirement for validation as a standalone command surface. The checks themselves are already specified; the reachable surface is not.

## Impact

- **`src/cli/`** — new `validate.ts`; `run.ts` records the graph into the store it builds.
- **`src/workflow/`** — `load.ts` gains validation stages and splits `buildWorkflow` out of `loadWorkflowFromString`; new `record.ts` holds the projection and its inverse.
- **`src/runstate/`** — `types.ts` gains `RecordedGraph`; `RunStateStore` accepts and records it.
- **Ledger** — GAP-02 and GAP-05 are closed by the new `run-state` spec (both already tracked by BR-04). GAP-01 (`watch` has no spec) is *not* closed here.
- **Docs** — README's CLI table gains `validate`.
- No breaking changes. `RunState.graph` is optional, so existing run documents parse unchanged, and every existing workflow file loads exactly as before.
