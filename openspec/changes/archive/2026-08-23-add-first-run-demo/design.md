# Design

## The seam

`src/cli/run.ts:344` is the entire injection point:

```ts
const sessions = resolved ? buildRunner(resolved.provider) : new SdkSessionRunner();
```

Everything downstream — `Engine`, `builtinExecutors`, `UiInteractionPorts`, the gate, the loop-backs, the run-state store — is indifferent to where agent text comes from. So the demo is a `SessionRunner` and a seeded repository, not a second execution path. This is the load-bearing decision: if `try` ever needs engine behaviour the real `run` does not have, the demo has stopped demonstrating the product and the change should be reconsidered rather than special-cased.

## Why the scripted runner must write files

`executeImplement` (`src/executors/agents.ts:31-36`) captures the git tree before the session, captures it again after, and derives `changedFiles` and `diff` from the difference. Nothing is taken from what the model said.

Two consequences, both good:

1. A scripted runner that only returns text produces an empty diff, a gate with nothing in it, and a test that can never go green. So the runner has to write the files a real agent would have written. This is the bulk of the work in the change.
2. Everything the gate shows is computed by real git from real files. The most important screen in the demo is not simulated at all.

## Why the real default graph

The alternative — a four-node demo graph — is faster and tells one story cleanly, but it demonstrates something `flow-code init` does not scaffold. A stranger who is convinced by a four-node graph and then meets ten nodes has been mis-sold, and the gap between demo and product is exactly the thing a first-run demo exists to close. Ten nodes at roughly two seconds each is within the thirty-second budget, and the default graph already contains both moments worth showing:

- `- { from: test, to: implement, loopback: { maxAttempts: 3 } }` — the test-failure loop-back the demo is built around.
- `- { from: gate, to: git-ops, when: "gate.decision == 'approved'" }` — nothing reaches git unapproved.

## Both gates pause; neither is special-cased

The default graph has two approval gates: `spec-gate` after `spec`, and `gate` before `git-ops`. The demo pauses at both, with no demo-specific gate handling anywhere.

The reasons are ordered:

1. **It is the least code.** Any auto-approval is a branch in the gate path that exists only for the demo, which is the thing this change is trying not to do.
2. **Pacing.** `spec-gate` arrives at node three and costs one keypress. It teaches the interaction while the stakes are nil, so the git gate at node eight lands as a decision rather than as the first key the user has ever pressed.
3. **A twenty-second run that never asks for input may not read as interactive at all.** The risk is not that the demo is too long; it is that a stranger watches it like a video and learns nothing about control.

## Disclosure

The banner follows `tierLine` exactly (`src/ui/App.tsx:552`, `2089`): a conditional header row, budgeted through `headerRows = HEADER_ROWS + (…)`. Not a new UI concept, and not a modal that can be dismissed and forgotten. It states that no live agent is running and no tokens are being spent, and it stays for the whole run.

The `demo` prop on `AppProps` mirrors `watch` (`src/ui/App.tsx:134`), which already establishes the pattern of a run-mode flag that changes the header.

## Discuss needs a second seam

`SessionRunner` is not the only boundary `executeDiscuss` (`src/executors/discuss.ts:55`) calls through. The assistant's replies come from `ctx.sessions.openInteractive(...).send(...)` — reachable from the scripted runner. The user's replies come from `ctx.ports.discuss.nextUserMessage(nodeId)` — a method on `InteractionPorts`, a wholly different injectable boundary that the real UI (`UiInteractionPorts`) implements by waiting on a keypress. Scripting the runner alone leaves that wait in place, and the demo hangs on the first Discuss node.

The fix is `DemoInteractionPorts`, and it has to be a **subclass** of `UiInteractionPorts`, not a wrapper implementing the `InteractionPorts` interface. `runUi`/`AppProps` are typed to the concrete class: the UI reads `ports.discussState`, `ports.pendingApproval`, and `ports.subscribe(...)` straight off the same instance the engine drives (`App.tsx:123, 449, 470-472, 513`), none of which exist on the interface. A wrapper satisfying only the interface cannot be handed to the UI at all — the type doesn't match, and even loosening it would leave the reactive state nothing populates.

The subclass overrides only the `discuss` field's `nextUserMessage`, keeping `begin`/`postAssistant`/`end` as the inherited methods — still mutating this same instance's reactive state exactly as a live run's do, so the scripted exchange renders in the real UI panel unmodified. `approval`, `convergence`, `plan`, and `testCommands` are untouched by inheriting the base class outright, which is what keeps the gate a real pause on real input rather than something the demo had to special-case.

`executeDiscuss` distinguishes an opening prompt, a reopening prompt (after a loop-back), a plain conversational turn, and the closing "respond with ONLY a JSON object" request — four different prompts sent through the same `session.send()`. Rather than track which turn a fixed-position script is on, the scripted runner reads the prompt itself: the closing request is the only one that asks for JSON, so matching on that phrase (already in `discuss.ts`'s own prompt text) tells the runner which shape to answer with, and works the same whether Discuss runs once or is reached again through a loop-back.

## Discuss and Spec are scripted, and say so

`discuss` is interactive: it opens a session and waits for the user to converse. A demo that blocks on the user inventing a feature request is not a thirty-second demo. The scripted runner auto-concludes it with a visible canned exchange, and the node's detail view carries a line marking the exchange as scripted. This is the one place the demo shows something a real run would do differently, so it is disclosed at the point it happens rather than only in the banner.

## The seeded repository

- `git init`, one commit, so `HEAD^{tree}` exists and the baseline behaves exactly as a real run's does.
- A small source file and a failing test, both plain JavaScript.
- The test command is `node --test`, pre-set in the seeded `workflow.yaml` as `test.config.commands`. Built into Node 20, so no install and no network.
- Pre-setting the commands also avoids the discovery prompt, and avoids `auto` — which the loader refuses in combination with a loop-back that can re-run the node (`src/registry/index.ts:80-91`), and this graph has exactly that loop-back.
- Created under `os.tmpdir()`, kept on exit, path printed.

## Non-TTY

Two blocking gates mean `npx … try | cat`, or `try` in CI, would deadlock. It follows the precedent already set for a dirty tree and for multi-graph selection (`src/cli/run.ts:123`): detect the absent TTY up front and fail with a message naming the reason, rather than hanging or silently auto-approving. Silently auto-approving would be the worst option available — it would demonstrate a gate being bypassed.

## Sequencing

The seeder and the scripted runner are independently testable without the UI, and the command is a thin composition of them. Task groups 1–3 can land and be tested before anything in the UI moves, so the banner is not on the critical path for proving the demo runs.
