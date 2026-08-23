## Why

BR-01 — *a stranger succeeds on their first run* — has no change serving it and no capability owning it. `STATUS.md` says so plainly, and GAP-10 records the reason: `src/init/`, `src/presets.ts`, the scaffold, and the discovery prompts are all real and all specified, but inside capabilities that serve BR-08. Nothing is about the outcome. Sixteen archived changes and 517 tasks have gone to the process machinery; the stranger has had none.

The gap is not documentation. It is that there is no way to see flow-code work without first committing to it. Today's shortest path from curiosity to a moving graph is: install, `init`, answer the preset picker, configure a provider, hold a Discuss conversation, and spend real tokens against a repository you care about — several minutes and a live API key before the first node lights up. Everything the product is actually claiming happens after that point: a test fails and the run loops back with the failure as context rather than ending; a gate holds a real diff and nothing reaches git without a human. Those are the two moments that distinguish flow-code from a chat window with a todo list, and no one currently sees either before deciding.

A demo that a curious developer can run in one line, with no repository, no configuration, and no credentials, is the missing first step. It is also the only artifact that makes `npx @easonliuuuuu/flow-code` a complete sentence.

## What Changes

- **A new `flow-code try` command.** Zero-argument, zero-configuration, zero-credential. It seeds a temporary git repository, runs the real default graph against it end to end, and finishes by printing where the repository is and what to do next. No repository is required to invoke it and nothing outside the temporary directory is touched.
- **A scripted session runner.** A `SessionRunner` that returns canned text per node and attempt, and — for the nodes that would edit the repository — writes the files a real agent would have written. The engine, executors, git operations, run-state, gates, and UI are the shipped ones.
- **A scripted Discuss loop.** `discuss`/`revise` take user replies from `InteractionPorts.discuss.nextUserMessage`, not from the session runner — a second seam the session runner cannot reach. A thin wrapper around the real ports answers only that one method from a script and passes everything else through untouched, so approval, convergence, and test-command confirmation all still reach the real UI exactly as a live run's do.
- **The demo is disclosed while it runs.** A persistent banner row in the UI header states that no live agent is running and no tokens are being spent, for as long as the run lasts. The demo is never presented as a live run and does not rely on the closing summary to say so.
- **The temporary repository is kept.** The run ends by printing its path, its `workflow.yaml`, and the `flow-code init` invitation. What the demo produced stays inspectable: a real git history, a real run-state document, a real workflow file.
- **The default graph is what runs.** Not a trimmed demo graph. `flow-code try` executes the same ten nodes and fifteen edges `flow-code init` scaffolds, so what a stranger sees is what they get.

## Capabilities

### New Capabilities
- `first-run-demo`: what a stranger can see before committing anything — the `try` command, the seeded repository, the scripted runner's contract, the disclosure requirement, and what the demo must demonstrate (a test failure that loops back and recovers, and a gate holding a real diff before git).

### Modified Capabilities
- `terminal-canvas-ui`: the header gains a disclosure row, on the same conditional-row mechanism `tierLine` already uses, and must budget for it.

## Impact

- `src/cli/try.ts` — new command; seeds, then reuses the existing run path.
- `src/demo/` — new module: the repository seeder, the scripted runner, and the script itself.
- `src/cli.ts` — `try` registered in the dispatch switch and the help text.
- `src/ui/App.tsx` — a `demo` prop and a header disclosure row, alongside `watch` and `tierLine`.
- `docs/product/coverage.yaml` — `first-run-demo` mapped to BR-01, the `demo` module and scope registered, and GAP-10 closed.
- `README.md` — the quickstart leads with `npx @easonliuuuuu/flow-code try`.

## Non-Goals

- No second renderer, no playback format, and no parallel engine path. If the demo needs a code path the real run does not have, that is a signal the seam is wrong.
- No trimmed or simplified graph. A demo of something `init` does not scaffold would be a different product's demo.
- No network access and no package installation. The seeded repository's test command must run on a stock Node 20.
- Not a tutorial. `try` shows one run; it does not teach the DSL, the presets, or guest mode.
