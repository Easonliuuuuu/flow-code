## 1. The seeded repository

- [x] 1.1 `src/demo/seedRepo.ts`: create a directory under `os.tmpdir()`, `git init`, configure a local `user.name`/`user.email` so the commit works on a machine with no global git identity
- [x] 1.2 Write the demo project: one small source file with a missing implementation, and one `node:test` file asserting the behaviour it does not yet have
- [x] 1.3 Write `.flow-code/workflow.yaml` as the real default scaffold with `test.config.commands` pre-set to `["node --test"]` — assert in a test that it is the default graph and not a copy that can drift
- [x] 1.4 Commit everything, so `HEAD^{tree}` exists and the run baseline resolves exactly as a real run's does
- [x] 1.5 Verify the seeded test actually fails under `node --test` on a stock Node 20, and that it passes once the scripted fix is applied — asserted directly, not through the engine
- [x] 1.6 Tests: the seeded repo is a valid git repo with one commit; the workflow file loads through `buildWorkflow` with no problems; the test command fails before the fix and passes after

## 2. The scripted session runner

- [x] 2.1 `src/demo/script.ts`: the per-node, per-attempt script — text for every agent-driven node in the default graph, and file writes for the nodes that would edit the repository
- [x] 2.2 `src/demo/DemoSessionRunner.ts`: implement `SessionRunner`, keyed on `nodeId` and attempt count, honouring both `run` and `openInteractive`
- [x] 2.3 `implement` attempt 1 writes the buggy implementation; attempt 2 — reached only via the loop-back, with the test failure in context — writes the fix. The runner must not be able to reach attempt 2 without the loop-back having fired
- [x] 2.4 `openInteractive` auto-concludes `discuss` and `revise` with a canned exchange, reporting a session id the way the real runners do so the resume path is not silently skipped
- [x] 2.4a `src/demo/DemoInteractionPorts.ts`: a subclass of `UiInteractionPorts` (not a wrapper — `runUi`/`AppProps` require the concrete class, since the UI reads its reactive state directly), overriding only `discuss.nextUserMessage`
- [x] 2.4b `discuss.begin`/`postAssistant`/`end` stay the inherited methods, so the scripted exchange still renders in the real UI panel through the same reactive state a live run populates
- [x] 2.5 Per-node pacing so the run is legible rather than instantaneous; a single knob, overridable to zero for tests
- [x] 2.6 Mark the scripted exchange in the Discuss node's own output, so the one place the demo diverges from a real run discloses itself where it happens
- [x] 2.7 Tests: the script covers every agent-driven node in the default graph (fails if a node is added and the script is not updated); attempt 2 differs from attempt 1; no network access and no child process beyond git and the test command

## 3. The `try` command

- [x] 3.1 `src/cli/try.ts`: seed, then drive the existing run path with `sessions` replaced — reusing `run.ts`'s engine construction rather than duplicating it
- [x] 3.2 Extract whatever `run.ts` needs to share so the runner is injectable without `try` copying the engine wiring; the shared path must remain the one a real run takes
- [x] 3.3 Refuse early and clearly when stdin is not a TTY, naming the two gates as the reason — never auto-approve a gate
- [x] 3.4 Closing summary: the repository path, the workflow file path, and `flow-code init` as the next step
- [x] 3.5 Register `try` in `src/cli.ts`'s switch and help text, keeping the dynamic-import discipline the file documents
- [x] 3.6 Assert `try` requires no credentials: it must run with every provider env var unset and no `claude`/`codex` login, in a directory that is not a git repository
- [x] 3.7 Tests: exits zero; leaves the temp repo behind; the temp repo has a commit made by the run; the summary names the path

## 4. Disclosure in the UI

- [x] 4.1 Add `demo?: boolean` to `AppProps`, documented alongside `watch`
- [x] 4.2 Render the banner as a conditional header row on the `tierLine` mechanism, and include it in the `headerRows` budget so the canvas does not lose a row to it
- [x] 4.3 The banner states that no live agent is running and no tokens are being spent, and persists for the whole run — not dismissible
- [x] 4.4 Tests: the banner is present in every frame of a demo run and absent in a normal run; the canvas height budget accounts for it; it survives a resize

## 5. Ledger and documentation

- [x] 5.1 `docs/product/coverage.yaml`: map the `first-run-demo` capability to BR-01
- [x] 5.2 Register the `demo` module and `demo` commit scope as accepted gaps (GAP-13, GAP-14) — `first-run-demo` isn't archived yet, so a live mapping would fail the same way scope/module mappings always do against an unarchived capability, same as `plan-node`'s precedent
- [x] 5.3 Map the `add-first-run-demo` change to BR-01 under `changes:`
- [x] 5.4 Close GAP-10, recording that BR-01 now has a capability that is about the outcome rather than describing it in pieces elsewhere — and leave GAP-11 open, which this change does not touch
- [x] 5.5 `README.md`: lead the quickstart with `npx @easonliuuuuu/flow-code try`
- [x] 5.6 Regenerate `STATUS.md` and confirm BR-01 no longer reads as unserved

## 6. Proving it end to end

- [x] 6.1 A test that drives the whole demo headlessly with pacing at zero: the run reaches `git-ops`, the test node fails once and passes on the retry, and a commit exists at the end
- [x] 6.2 Assert the loop-back actually fired — the run is worthless as a demo if the test happens to pass first time
- [x] 6.3 Assert the gate saw a non-empty diff computed from real git, not from scripted text
- [x] 6.4 Drive `try` by hand in a real pty and confirm the thirty-second claim, both gates pausing, and the banner staying put
- [x] 6.5 Run it from a packed tarball via `npx`, in a non-git directory with no credentials, which is the exact path the README will advertise
