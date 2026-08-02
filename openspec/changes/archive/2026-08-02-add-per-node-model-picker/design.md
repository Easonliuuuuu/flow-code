## Context

The engine already supports a per-node model: every agent-driven node type declares `model?: string` in its config schema (`src/registry/index.ts`), and `nodeModel()` resolves `config.model ?? ctx.settings.model` (`src/executors/helpers.ts:66`). Nothing in the run UI can set it, so the field is only reachable by hand-editing `.flow-code/workflow.yaml` between runs.

Three existing facts shape the design:

- **One provider, one runner.** `cmdRun` resolves a single provider and builds one `SessionRunner` for the whole engine (`src/cli.ts:332`, `src/engine/types.ts:116`). Per-node *model* costs nothing here; per-node *provider* would require a runner per node and multi-provider credentials, and is out of scope.
- **The workflow file is hand-edited and checked in.** It ships with explanatory comments (`src/defaultWorkflow.ts`), so any writer must round-trip comments and key order, not re-emit the document from a parsed object.
- **The model list is already built, but it is async and network-bound.** `fetchModelIds(provider, apiKey)` (`src/init/modelList.ts`) does a live `/v1/models` GET for NVIDIA/OpenAI/OpenRouter with a 10s timeout, and returns a curated static list for Claude. It was written for the init wizard, which can block; the run UI cannot.

## Goals / Non-Goals

**Goals:**

- Change any pending node's model from inside a live run, keyboard-first, without restarting.
- Persist the choice to `.flow-code/workflow.yaml` without disturbing the user's comments or formatting.
- Make an override visible on the graph, and make the resolved model and its origin visible in the detail view.
- Reuse the init wizard's model list and select list rather than growing a second picker implementation.

**Non-Goals:**

- Per-node **provider**. Needs a runner per node, credentials for multiple providers, and per-node preflight — a separate change.
- Editing any other node config (instructions, topic, test commands) from the UI. The picker's plumbing should generalize later, but this change ships model only.
- A general node context menu. The interaction is a focused-node key with a click alias; a menu framework can come when there is a second entry to put in it.
- Changing the model of a node whose session is already in flight.

## Decisions

### Write with the `yaml` Document AST, re-reading immediately before the write

`yaml` is already a dependency and `parseDocument()` preserves comments, blank lines, and key order across `setIn`/`deleteIn` + `toString()`. The alternative — `load.ts`'s parsed `Workflow` object re-serialized with `stringify` — would silently delete every comment in the scaffolded file the first time a user picked a model, which is unacceptable for a checked-in file.

The writer re-reads the file immediately before editing rather than holding a document parsed at run start, so an edit the user made in their editor mid-run is not clobbered. After the edit it re-validates the result through the existing loader and refuses to write a document that would no longer load. Writes go through a temp file + rename so a crash mid-write cannot truncate the workflow.

Selecting the model that `settings.model` already names deletes `config.model` instead of writing a redundant override — the file stays as close to hand-written as possible, and the node keeps following the default if the default later changes.

### Apply to the current run by mutating the pending node's config

The engine reads `ctx.node.config` when it starts a node, so setting `config.model` on a not-yet-started node in the in-memory workflow is enough for the current run — no engine change and no restart. `cmdRun` already mutates the loaded workflow this way (`workflow.settings.model = resolved.model`, `src/cli.ts:225`), so this is established practice rather than a new liberty.

The alternative, a per-node override map in the run-state store consulted by `nodeModel()`, is cleaner in principle — the store is the place run-scoped state lives, and it would survive `--resume` — but it touches the engine, executors, and run-state schema to buy something the file write already provides: a resumed run re-reads the workflow file and picks the new model up from there.

Nodes that are `running` or `done` are read-only in the picker. Silently accepting a change that has no effect is the worst option; the picker states that the change applies on re-run, and a loop-back re-run then reads the mutated config like any pending node.

### Load models asynchronously, once per run, with free-text fallback

The picker opens immediately in a loading state and fills in when `fetchModelIds` resolves; the result is cached for the run so reopening it is instant. Ink's input loop must never block on a 10s network call. When the fetch fails, the picker falls back to free-text model entry with the error shown — the same degradation the init wizard already performs, and a model id the user types is passed through unvalidated, since the provider is the authority on what it accepts.

The API key comes from the environment: `resolveProvider` already exports the stored key into the provider's env var before the run starts (`src/cli.ts:64-70`), so the UI reads `process.env[providerInfo(provider).apiKeyEnvVar]` rather than re-reading `credentials.json`.

### Pass model provenance into the UI explicitly

`cmdRun` overwrites `workflow.settings.model` with the credentials' model when the workflow declares none, which erases the distinction the detail view is supposed to show ("from the run settings" vs "from the provider default"). The UI therefore receives the workflow's own `settings.model` and the provider default as separate values, captured before that overwrite, and derives provenance from node config → workflow settings → provider default.

### `m` on the focused node, click on the badge as an alias

`mouse.ts` states the invariant that mouse is an enhancement layer and every interaction stays keyboard-operable, so the key binding is the real interface. Click cannot be the primary gesture anyway: press-on-a-node already starts a position drag in the mouse handler, and distinguishing a click from a drag means tracking press→release with no intervening motion. Scoping the click target to the model badge sidesteps that ambiguity — the badge is not a drag handle.

The picker renders in the existing status panel, so it inherits the move/resize/dock behavior that panel already has rather than introducing a second overlay concept.

## Risks / Trade-offs

- **A model id valid for one provider is meaningless for another** → the picker only ever lists the configured provider's models, and the file records a bare model string exactly as the config schema already defines it. Switching providers later leaves stale per-node models — the same failure the existing `settings.model` already has, surfaced no worse by this change.
- **Free-text fallback lets a typo reach the provider** → the failure is a clear per-node session error naming the bad model, not a silent wrong-model run; the picker shows the fetch error so the user knows why they are typing instead of choosing.
- **A concurrent external edit to the workflow file could be lost** → read-modify-write immediately before saving narrows the window to milliseconds; a full lock is not worth it for a single-user local tool.
- **Mutating the loaded workflow mid-run is invisible to React** → intentional: the engine reads config at node start, and the badge re-renders from the same object on the next frame. It does mean the in-memory workflow and the file can diverge if the file write fails, so a failed write reports in the UI and leaves the in-memory change in place only for the current run.
- **The picker adds a keyboard mode to `App.tsx`**, which already multiplexes discuss, approval, convergence, and navigation modes → the change should extract the mode dispatch if adding a fifth branch makes the handler unreadable, but not as a prerequisite.

## Migration Plan

No migration. `config.model` is already an optional field in the schemas and already honored by the engine; workflows that never open the picker are unaffected, and files written by the picker remain loadable by earlier versions.

## Open Questions

- Should the picker offer "clear override" as an explicit list entry, or is selecting the default model (which deletes the key) discoverable enough on its own?
- Does the badge belong on the node box for every overridden node, or only when the graph is wide enough that it does not crowd short node ids? The box width is computed from the id today.

## Implementation addenda

Two refinements surfaced while implementing that are worth recording here rather than only in code comments, since they sharpen decisions this document already made:

**"Read-only" on a running/done node means the immediate execution, not the file.** The Decisions section above says such nodes are "read-only in the picker," but the spec's own "Re-run after a change" scenario requires a model changed while a node is `done` to take effect on a later loop-back re-run — which only works if the write still happens. The implementation resolves this in the spec's favor: the picker stays interactive on a running/done node (with the on-screen notice explaining the change won't touch the current attempt), `setNodeModel` still writes the file, and the same node's in-memory `config.model` is still mutated. Mutating it is harmless in both cases — a running node already captured its model into the request it sent before this could run, and a done node's config is only read again if a loop-back resets it. This removed the need for any status-based branching in `confirmModel` at all.

**The badge and the retry (`↻N`) indicator share one slot.** `BOX_HEIGHT` is a global constant the whole canvas's edge-drawing math depends on (`sy = from.y + 1`, `GAP_Y`, etc.), so growing a box by a row for nodes with an override wasn't on the table without touching layout.ts and canvas.ts's edge routing together — out of proportion to this change. The model badge instead lands in the same right-aligned corner of the type-label row the retry badge already used, with the retry badge winning on the rare frame both apply (a node freshly re-run by a loop-back and carrying a model override) — it's the more transient, more urgent of the two, and the model stays visible in the detail view regardless.
