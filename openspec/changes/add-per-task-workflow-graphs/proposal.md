## Why

`add-workflow-validation-and-recorded-graph` made a run record the graph it is executing, and made a workflow file checkable without running it. Nothing reads the recording yet, and a repo still carries exactly one graph.

This change spends that foundation: readers use what the run recorded instead of re-loading a file that may have moved underneath them, and a repo can carry several named shapes of its process so a typo fix and a risky refactor stop having to share one.

## What Changes

- **`watch` renders the graph the run recorded** — not the current contents of `.flow-code/workflow.yaml`, and with no fallback to it. A run document carrying no recorded graph reports its shape as unavailable.
- **`--resume` executes the recorded graph** rather than reloading the file, and says that is what it is doing, so a diverged workflow file is a visible fact instead of a silent one.
- **Mid-run node edits update the recording and the file together**, behind one path, so the run document cannot end up describing a model that is not the one running. An edit naming a node the recorded graph does not have is rejected.
- **A workflow file may declare multiple named graphs**, validated independently, with `settings` declared once. A single-graph file stays valid and keeps its current meaning.
- **`run` selects which graph it executes** before any node starts — explicitly, interactively, and never by guessing when there is no terminal to ask in.

## Capabilities

### New Capabilities
_None. Both capabilities this change touches already exist._

### Modified Capabilities
- `run-state`: gains requirements for what a reader may conclude from a recorded graph, for edits keeping the recording in step, and for resume executing what was recorded.
- `workflow-graph`: gains requirements for a file declaring multiple named graphs and for how a run selects among them.

## Impact

- **`src/ui/`** — the open decision, below. `runUi` takes `workflow` as a static prop at mount and `App` memoizes its layouts on it, which is incompatible with a viewer that learns the graph only when it attaches to a run.
- **`src/runstate/`** — `watch.ts` renders from the recorded graph and loses `reconcileRunState`.
- **`src/workflow/`** — `schema.ts` becomes a union over the single-graph and named-graph forms; `write.ts`'s setters move behind one edit path.
- **`src/cli/`** — `run.ts` resolves and records the selected graph; `watch.ts` stops loading the workflow file for node ids.
- **Ledger** — GAP-01 (`watch` has no capability spec) is in scope to close here if `watch`'s own behaviour ends up specified; otherwise it stays open.
- **Docs** — `docs/workflow-reference.md` gains the named-graph form; README gains graph selection.
- Not breaking: existing single-graph files and existing run documents both keep working.

## Open Decision — settle before design is final

`runUi` takes `workflow` as a static prop at mount (`src/ui/index.ts:44`), and `App` memoizes all four layouts on it. `cmdWatch` cannot know the recorded graph at mount time: it attaches to a run later, and `emptyRunState` exists precisely so the graph is on screen before any run exists.

Deriving the workflow inside `App` from `runState.graph` is the obvious move and is worse than it looks — on the `run` path `state.graph` is always present, so `App` would re-rehydrate a graph it was already handed, adding disk I/O and a new failure mode to the main path, and the natural fallback when rehydration fails is to use `workflow.yaml`, which is the substitution these requirements forbid.

Two candidates, neither yet chosen:

1. **Make `runUi`'s workflow swappable** — it accepts an initial shape plus updates; `run` passes its in-memory `Workflow` once and is unaffected, `watch` pushes the rehydrated graph when it attaches. Bigger diff through `ui/index.ts` and `App.tsx`.
2. **Defer `watch`'s mount until it attaches** — smallest diff, but it costs the "graph on screen immediately" property `emptyRunState` was built for, and a viewer left open across two runs of different shapes cannot swap.
