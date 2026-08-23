# Glossary

flow-code has more vocabulary than a tool this size should need, and most of it
was defined in the code rather than anywhere a reader would find it. This page
is the one place each term is spelled out. Nothing here is required reading to
run `flow-code init` — it exists for the moment a word in another page turns out
not to mean what it sounds like.

---

## The graph

**Node** — one step of a run: a card on the canvas, and at most one agent
session. Every node has a **node type**, which fixes three things about it: the
capabilities it holds, the role prompt it runs under, and the shape of the
output it must return. See the [node type reference](node-types.md).

**Edge** — where the run goes next. An edge routes; it never judges. Whether the
node it leaves succeeded is that node type's call, and an edge can only read
that verdict.

**Gate** — an `approval-gate` node. It stops the run and waits for a human yes
or no. It spends no tokens and it cannot be satisfied by an agent. The default
graph has two: one before any code is written, one before anything touches git.

**Loop-back** — an edge that is a *return* path. When its source fails, the run
goes back to the target and re-runs everything in between, with the failure
passed along as context — so a failing test is another iteration rather than the
end of the run. Bounded by `maxAttempts`, counted once per target across every
loop-back pointing at it.

**Spine** — the part of a graph that is fixed before the run starts, when the
rest is not. Only the `planned` preset has one: a `plan` node, a gate, and a
git-ops step, with the middle negotiated with you at run time and spliced in.

**Named graph** — a `workflow.yaml` may declare several graphs by name instead
of one flat `nodes`/`edges` list — a quick shape and a heavily verified one, say.
`flow-code run --graph <name>` picks one.

**Preset** — a starting `workflow.yaml` and nothing more. A preset composes
existing node types with skills; it adds no new node kinds and no new
capabilities. `openspec`, `spec-kit`, `frugal` and `planned` are all ordinary
graphs, editable like anything else.

**Skill** — a `SKILL.md` file attached to a node, giving it project- or
team-specific instructions on top of its built-in role. A skill governs *how* a
node works; the node type still owns what it must return and what it may touch.
See [Skills](skills.md).

**Subagent** — a session an agent-driven node delegates to. It runs under its
parent node's capability set and working directory, and counts against
`concurrency` and the budget like any other session. `settings.subagents: false`
turns delegation off — a lever for cost and predictability rather than safety,
since the capability bound applies either way.

**Worktree** — a separate git working directory a node can run in, so several
nodes can write code at once without colliding. Created and cleaned up by the
run; `flow-code doctor` clears the ones a crash left behind.

---

## Running and watching

**Run** — one execution of a graph, identified by a `runId`. Its state lives in
`.flow-code/runs/<runId>.json`.

**Run record** — that JSON file. It holds each node's status, token spend,
output, and, for a Discuss node, the **verbatim transcript** of the
conversation. Local history rather than project history, and gitignored by
default — see [Security and privacy](security.md).

**Driver** — the process that is executing the run and is allowed to write its
run record. Exactly one process owns a run at a time; a second writer is refused
rather than allowed to interleave. This is why a reader can follow a run without
locking or slowing it.

A driver reads as one of three things, and every reader (`watch`, `runs`,
`status`, `doctor`) reports them apart:

| Liveness | Means |
| --- | --- |
| `live` | The owning process is running and the run is being written |
| `gone` | The owner died without finishing — resumable with `flow-code run --resume` |
| `unknown` | The run was started on another machine, so its pid is not ours to check |

**Budget** — a ceiling that stops a run: tokens per node, tokens per run,
wall-clock minutes per run. A budget stop is final and never triggers a
loop-back — retrying past a ceiling is what the ceiling exists to prevent.
Tokens served from cache do not count against one.

---

## Driving the graph from your own agent

`flow-code run` executing the graph is one option, not a requirement. The terms
below only matter if you walk the graph yourself from `claude`, `codex`, or
another agent CLI. See [Driving the graph from your own
agent](agent-integration.md).

**Host session** — the agent session *you* are already running, which flow-code
did not spawn. Your Claude Code or Codex window.

**Guest** — flow-code's surface inside that host session: the MCP tools, the
skill, the instructions section, and the enforcement hook that `flow-code
connect` installs. Named for the relationship — flow-code is a guest in a
process it does not own, reporting on a run rather than driving one.

**Harness** — the layer that compiles a node's capability set into restrictions
the session actually enforces. A node without `edit` cannot write files,
whatever its instructions say. This is what makes a **capability** a guarantee
rather than a request.

**Capability** — a permission a node type holds, such as `read`, `edit`, or
`git`. Fixed by the node type, enforced by the harness, and inherited by any
subagent.

**Enforcement tier** — how much of that guarantee a given run actually had. It
depends on who spawned the session, and a run records the weakest tier it ever
held rather than the one it opened with.

| Tier | What spawned the session | What it guarantees |
| --- | --- | --- |
| `engine` | flow-code itself | Everything: capabilities enforced, process guards, per-node model, token accounting, automatic loop-back routing |
| `hooks` | Your host agent, with the enforcement hook installed | Tool calls outside a node's capability set are blocked; the rest is the host's own behaviour |
| `reported` | Your host agent, reporting only | Nothing is enforced — the graph reflects what the session *said* it did |

**Reconcile** — `flow-code reconcile` checks a run's claims against the
repository: which completed nodes reported work the tree does not show. It is
read-only and advisory, and it is the check that makes a `reported`-tier run
worth anything.

---

## Providers

**Provider** — which service runs the agent sessions: Claude, Codex, OpenAI, or
OpenRouter. Chosen once per project by `flow-code init` and stored in
`.flow-code/credentials.json`.

**Credential reuse** — `init` looks for credentials you already have before
asking for any. If you are logged into the `claude` or `codex` CLI, or already
export an API key, there is nothing to paste — and a CLI login draws on that
subscription rather than metered API billing.

**Model resolution** — a node's effective model is the first of: its own
`config.model`, the workflow's `settings.model`, or the provider's default. All
three are resolved when flow-code starts the session, so they apply to
`flow-code run` and nothing else — a run driven from your own session picks its
own model per step.
