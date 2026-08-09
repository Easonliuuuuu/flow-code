## Context

`.flow-code/workflow.yaml` is loaded once, at `src/cli/run.ts:132`, and the resulting `Workflow` lives only in the driving process. The run document records per-node execution state keyed by node id and nothing about the shape those ids belong to. `watch` therefore loads the workflow file itself and reconciles the persisted state against it — `src/runstate/watch.ts:56-73` says outright that the two "cannot be assumed to agree," because the file may have been edited since the run began.

That is tolerable while one file means one graph for one repo. It stops being tolerable the moment a run's shape is chosen per task: there is then no file a reader could load that would tell it what a given run is doing.

The validation machinery is in better shape than the surface suggests. `loadWorkflowFromString` already collects problems into a list and throws `WorkflowValidationError` carrying `problems: string[]`, and `loadWorkflowOrFail` already prints them as a listing. What is missing is a way to reach any of it without starting a run.

## Goals / Non-Goals

**Goals:**
- Make a workflow file checkable without executing anything, including saying which checks a failure stopped.
- Make a run document carry the graph it is executing, and make that recording rebuildable into a runnable workflow.
- Change nothing about how a run behaves today.

**Non-Goals:**
- Making `watch` and `--resume` *use* the recorded graph. This change writes it and proves it round-trips; reading it is `add-per-task-workflow-graphs`, which needs a decision this change should not make in passing (below).
- Named graphs, graph selection, or anything per-task.
- Generating or composing a graph from a discussion.
- Treating `workflow.yaml` as policy constraining a per-task graph. That reframing is likely where this goes next; nothing here should foreclose it, and nothing here should assume it.

## Decisions

### `validate` reuses the load path rather than getting its own checker

`flow-code validate` calls the same `loadWorkflow` that `run` calls, catches `WorkflowValidationError`, and formats it. It gains no checks of its own.

*Alternative considered:* a standalone validator that inspects the file independently. Rejected — two implementations of "is this valid" drift, and the spec requires that a file `validate` passes cannot then fail a pre-execution check. Sharing one code path makes that true by construction rather than by discipline, and a fixture table in the tests asserts the two agree on accept/reject.

### The loader is staged, and a failure says what it stopped

Today a YAML parse failure and a file-schema failure each throw immediately, so structural problems behind them are never reached — and reporting only failures would let someone read that silence as a clean bill. `WorkflowValidationError` gains a `stage` (`parse` → `file-schema` → `declarations` → `structure`), leaving `problems` untouched so every existing caller is unaffected.

Within `structure`, the loop-back, test-auto, and condition checks now report together instead of one build at a time: they are independent of each other. Two things still gate rather than collect. A cycle stops the stage, because every remaining check reads ancestry over the forward-edge subgraph and a cycle makes that meaningless. And the test-auto check is skipped when a loop-back is already known to point the wrong way, since it reads `nodesBetween` over exactly those loop-backs and would report a second problem about the same broken edge.

### The recorded graph is a serializable projection, not the `Workflow` object

`Workflow.nodes[].type` is a `NodeTypeDefinition` holding zod schemas and predicate functions, and `Workflow.graph`/`Workflow.order` are derived adjacency and topological order. None of that belongs in JSON.

The run document records a projection: per node an id, a node **type id**, its validated config, and its budget; per edge a from, a to, its loop-back and its condition; plus the run settings that applied. Reading rehydrates that projection rather than trusting derived structure that was serialized once and could disagree with the code reading it.

*Alternative considered:* embedding the raw YAML text of the selected graph. Rejected — a reader would have to re-parse and re-validate to render anything, which is the coupling this change exists to remove.

### Rehydration goes through the same builder as a fresh load

`loadWorkflowFromString` splits into parse-and-shape plus `buildWorkflow`, and `rehydrateGraph` calls `buildWorkflow` with the recorded nodes and edges. A resumed run and a fresh one therefore agree on what a valid graph is by construction.

This also gets skill handling right for free. `config.skills` already names the skills, so a recorded config carries them and rehydration re-resolves them from the reading machine's roots — which is correct, because where a skill lives is a property of the machine, not of the run.

Rehydration can fail: a run interrupted under one build and resumed under another may name a node type the registry no longer has. `RecordedGraphError` names the node and the type rather than silently dropping the step.

### The recorded graph is optional on the type, and one list seeds both

`RunState.graph?` is optional, so run documents written before this change still parse. `RunStateStore` takes either `nodeIds` or a `graph`, and when given a graph derives the node ids from it — so the node map and the recorded shape cannot be seeded from two lists that disagree.

### Reading the recorded graph is split out, deliberately

Making `watch` render from the recorded graph runs into something this change is the wrong place to settle: `runUi` takes `workflow` as a static prop at mount (`src/ui/index.ts:44`) and `App` memoizes all four layouts on it, but `cmdWatch` cannot know the recorded graph at mount time — it attaches to a run later, and `emptyRunState` exists precisely so the graph is on screen before any run exists.

The obvious fix, deriving the workflow inside `App` from `runState.graph`, is worse than it looks: on the `run` path `state.graph` is now always present, so `App` would re-rehydrate a graph it was already handed — disk I/O and a new failure mode on the main path — and the natural fallback when rehydration fails is to use `workflow.yaml`, which is exactly the substitution the reader requirements forbid.

That is a UI-architecture decision with real alternatives, so it gets its own change and its own design pass rather than being made on the way past. This change is complete and useful without it: the graph is recorded, and the round trip is proven.

## Risks / Trade-offs

- **A recorded graph nothing yet reads is dead weight, and could rot before its consumer lands.** → The round-trip test exercises projection, serialization, and rebuild on a graph with loop-backs, a per-node budget, and a condition, so a regression fails a test rather than waiting for the follow-on change to discover it.
- **Run documents grow by the size of the graph**, on a document already rewritten on every state change. → Bounded by the graph. Acceptable, but worth measuring on the largest graph in the test suite rather than assuming.
- **Collecting structural failures changes which problems a run reports.** → Additive: every message that was reported before is still reported, and more may accompany it. Existing tests assert on content rather than count and all still pass.

## Migration Plan

No data migration. `RunState.graph` is additive and optional; workflow files are unchanged. `validate` is self-contained and could ship on its own.

## Open Questions

- Should a named graph override the *non-ceiling* parts of `settings` — `model`, `concurrency`, `subagents`? Deferred with named graphs themselves to `add-per-task-workflow-graphs`, recorded here because the recorded graph carries `settings`, which is the thing that would have to become per-graph.

**Resolved while writing, recorded so they are not reopened by accident:**

- *Can a named graph raise the budget?* No. A ceiling the shape gets to raise is not a ceiling; a shape that needs more work carries more nodes, each with its own `node.budget` (`src/workflow/load.ts:144`). Considered and rejected: dropping the scaffolded budget numbers so the question is moot — `src/defaultWorkflow.ts:25-29` ships real ceilings deliberately, and unbounded plus the scaffolded loop-backs at `maxAttempts: 3` is exactly the runaway the ceiling exists to stop.
- *Does the `run-state` spec close GAP-01?* No. This change specifies the run *document*; `watch` as a command — how it attaches, pins to a run id, refuses writes, and reports liveness — is still unspecified. GAP-01 stays open under BR-03.
