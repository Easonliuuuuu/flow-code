## Context

`add-workflow-validation-and-recorded-graph` shipped the substrate: `RecordedGraph` on `RunState`, `recordGraph`/`rehydrateGraph` in `src/workflow/record.ts`, and `RunStateStore` seeding its node map from the graph it records. Nothing reads it. `src/runstate/watch.ts` still reconciles persisted state against a separately-loaded `workflow.yaml`, and `src/cli/watch.ts` still loads that file purely to get node ids.

This change makes the readers use it, and then adds the reason to care: a file that can hold more than one shape.

## Goals / Non-Goals

**Goals:**
- `watch` and `--resume` read the graph the run recorded, with no fallback to the workflow file.
- Mid-run edits keep the recording and the file in step, through one path.
- A workflow file can declare several named graphs; a run selects one before anything starts.

**Non-Goals:**
- Generating or composing a graph from a discussion. This change makes shapes selectable, not authored.
- Structural graph editing in the TUI (adding, removing, rewiring nodes).
- Treating `workflow.yaml` as policy constraining a per-task graph — the likely next reframing, deliberately not assumed here.

## Decisions

### Named graphs are a `graphs:` map, mutually exclusive with top-level `nodes`/`edges`

```yaml
settings: { ... }          # once, applies to whichever graph runs
graphs:
  quick:
    description: Small, well-understood changes.
    nodes: [...]
    edges: [...]
  hardened:
    description: Risky changes — extra validation, review before gate.
    nodes: [...]
    edges: [...]
```

`workflowFileSchema` becomes a union over the two forms. A file declaring both is invalid rather than resolved by precedence — a precedence rule is a thing to get wrong silently. Each named graph is validated independently and in full, with every failure attributed to its graph, which the staged `WorkflowValidationError` already has room to carry.

*Alternative considered:* one file per graph under `.flow-code/graphs/`. Rejected for now — a single file is what makes several shapes reviewable against each other in one diff, and splitting them would either duplicate `settings` or require a separate policy file this change is not ready to design. If the count grows past what one file can hold legibly, this is the seam.

### A named graph cannot override the run budget

`settings` — the budget included — is declared once. A ceiling the shape gets to raise is not a ceiling, and a `hardened` graph that could grant itself more room than `quick` would make the run's maximum cost a function of a choice made after the file was reviewed. A shape that needs more work carries more nodes, each with its own `node.budget`. A `budget` inside a named graph is rejected, naming the graph.

There are exactly two budget scopes, and this is the settled model: **run-wide, and per-node.** Nothing sits between them.

### The run meter reads against the selected graph, not the run ceiling

Rejecting a per-graph budget leaves a real problem, and it is worth naming because it is the honest half of the argument for one. `settings.budget` has two jobs: it stops a run, and — per `brief.md`, where "what it cost" is one of the three things a chat log hides — it makes cost legible. The stop wants one number set for the most expensive shape. Legibility does not: a `quick` run reporting "3k of 2,000,000" is a proportion that tells you nothing.

The fix is to derive rather than declare. The expected cost of a run is the sum of the selected graph's per-node budgets, which is shape-specific by construction and needs no new field in the file. `tokensPerRun` stays exactly what it is — the hard backstop no shape can raise — and stops being asked to double as the denominator on a meter.

*Alternative considered:* letting a named graph declare its own budget purely for display. Rejected — a number that looks like a ceiling and is not one is worse than either.

### Per-node minutes, if it lands, overrides the per-node default and never the run ceiling

Tracked separately (see `docs/product/inbox.md`) because it is a budget feature rather than a named-graph one, but the precedence has to match what `node.budget.tokens` already does: it overrides `settings.budget.tokensPerNode`, a per-node *default*, and never `tokensPerRun`. A node that could outlive `minutesPerRun` would be the ceiling-the-part-can-raise problem one level down. A node stops at whichever comes first — its own limit, or what is left of the run's.

### Selection happens before the first node, and is recorded

`run` resolves the graph name up front: from an explicit name if given, otherwise via the `selectFromList` picker `init` already uses. Without a TTY and without a name the run fails rather than guessing — picking a verification depth on the user's behalf is exactly the decision this feature exists to give back. `RecordedGraph.selected` already exists to carry the answer.

## Open Decision — settle first

Making `watch` render from the recorded graph is blocked on how the UI receives its workflow. `runUi` takes `workflow` as a static prop at mount (`src/ui/index.ts:44`) and `App` memoizes all four layouts on it, but `cmdWatch` cannot know the recorded graph at mount time: it attaches to a run later, and `emptyRunState` exists precisely so the graph is on screen before any run exists.

Deriving the workflow inside `App` from `runState.graph` is the obvious move and is rejected: on the `run` path `state.graph` is always present, so `App` would re-rehydrate a graph it was already handed — disk I/O and a new failure mode on the main path — and the natural fallback when rehydration fails is `workflow.yaml`, the exact substitution these requirements forbid.

1. **Make `runUi`'s workflow swappable.** It accepts an initial shape plus updates; `run` passes its in-memory `Workflow` once and is unaffected; `watch` pushes the rehydrated graph on attach. Correct for a viewer left open across runs of different shapes. Costs a real diff through `ui/index.ts` and `App.tsx`, and `app.watch` tests move with it.
2. **Defer `watch`'s mount until it attaches.** Smallest diff. Costs the "graph on screen immediately" property `emptyRunState` was built for, and a viewer spanning two runs of different shapes cannot swap.

Task 1.1 is settling this. Everything in sections 3–5 is independent of the answer and can proceed either way.

## Risks / Trade-offs

- **Named shapes invite copy-paste: three graphs differing by two nodes, drifting apart.** → Not solved here, and it should not be papered over with partial inheritance, which is harder to read than duplication. This is the strongest argument for the eventual "policy plus composition" reframing, recorded as such rather than pre-built.
- **A prompt before every run is a regression for someone who only ever wants one shape.** → A single-graph file never asks, and stays what `init` scaffolds. The question exists only in files that opted into having something to ask about.
- **Dropping `reconcileRunState` changes behaviour for old run documents.** → Deliberate and specified: they report their shape as unavailable.

## Open Questions

- Does specifying how `watch` renders close GAP-01, or does `watch` still need a capability spec about the command itself (attaching, pinning, refusing writes, reporting liveness)? Assume not closed until the shape of section 2 is settled.

**Resolved, recorded so they are not reopened by accident:**

- *Can a named graph override the budget?* No. Two scopes only — run-wide and per-node — with the run meter deriving its denominator from the selected graph rather than a declared per-graph number. Both decisions above.
- *Can a named graph override the non-ceiling settings — `model`, `concurrency`, `subagents`?* Not now. The budget argument genuinely does not reach them (a `quick` shape wanting a cheaper default model is a preference, not an escape from a limit), so this is a deprioritization rather than a refusal: no real user has asked, and inventing the config surface ahead of the demand is how a file grows fields nobody set. Revisit on a request, not on a hunch.
