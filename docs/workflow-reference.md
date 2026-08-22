# Workflow reference

Everything `.flow-code/workflow.yaml` accepts. The file is checked into your repo, so
a workflow travels with the project that uses it.

For what each node type does and what it can be configured with, see
[node-types.md](node-types.md).

```yaml
settings:   # optional — run-wide limits
nodes:      # required — at least one
edges:      # optional — defaults to no edges
```

Unknown keys are rejected at load time rather than ignored, so a typo is an error
you see before the run starts.

## Nodes

```yaml
nodes:
  - id: implement          # required — alphanumeric, plus - and _
    type: implement        # required — see node-types.md
    budget:                # optional — this node's own ceiling
      tokens: 800000
    config:                # optional — validated per node type
      instructions: Implement what the upstream spec requires.
```

`id` is yours to choose and is what edges and conditions refer to. Nothing stops you
from running two nodes of the same type with different ids and different config.

`config` is validated against the node type's own schema, so an unknown or
wrong-typed field fails the load rather than being silently dropped.

## Edges

An edge routes, it does not judge — it says where the run goes, never whether a
node succeeded:

```yaml
edges:
  - { from: implement, to: test }
```

A node runs once every path into it has been resolved, and is given the recorded
outputs of the nodes it is wired to — and nothing else. Context follows the graph,
which is why an edge you did not draw is context a node does not get.

### Loop-backs

A loop-back is a return path: when `from` ends, execution resumes at `to` and
re-runs everything between them, with the outcome passed in as context.

```yaml
  - { from: test, to: implement, loopback: true }               # 3 attempts (default)
  - { from: validate, to: implement, loopback: { maxAttempts: 5 } }
  - { from: revise, to: implement, loopback: { on: success } }  # see below
```

Whether a node succeeded or failed is the node type's call, not the edge's —
`validate` and `review` fail on their own `fail` verdict, `test` on a non-zero exit
status. The edge only says where each outcome routes.

`on` says which outcome takes the path:

| `on` | fires when | for |
| --- | --- | --- |
| `failure` (default) | the source fails | verification loops — a failing check is another iteration, not the end of the run |
| `success` | the source completes | a step whose whole job is deciding what to change next, reached because something upstream was rejected |

`on: success` exists for one shape: a node reached *because* work was turned down,
whose conclusion is itself the reason to retry. Waiting for such a node to fail would
mean waiting forever. Everywhere else, `failure` is what you want — a check that
passes has no reason to send the run backwards.

`maxAttempts` is counted **on the target** and shared across every loop-back pointing
at it, whatever their triggers. Three loop-backs into `implement` at `maxAttempts: 3`
give you three retries in total, not nine — so a loop that never converges still
terminates. After that the outcome stands and downstream nodes are skipped.

When a loop-back fires, any branch that was skipped because a routing condition sent
the run elsewhere is put back in play: the segment re-running is what decided that
routing, so the skip no longer stands. A branch skipped because something above it
*failed* stays skipped.

A loop-back cannot carry a `when:`. A return path is taken because of how its source
ended, which is what `on` already says.

### Conditional edges

An edge with a `when:` still waits for its source, but only carries when the condition
holds. When it does not, its target is skipped along with the rest of that branch. A
node the branches rejoin at still runs, as long as some other path into it was taken.

```yaml
  - { from: implement, to: gate, when: "implement.changedFiles isNotEmpty" }
  - { from: test, to: triage, when: "test.passed == false" }
  - { from: review, to: rework, when: "review.findings.length > 0" }
```

The condition language is deliberately tiny — one question about one node's recorded
output, no expression evaluation, no boolean combinators:

```
<nodeId>.<field> <operator> [<value>]
```

| | |
| --- | --- |
| **Reference** | `<nodeId>` plus a dot path into its output. `.length` works on arrays and strings. |
| **Binary operators** | `==` `!=` `>` `<` `>=` `<=` `contains` |
| **Unary operators** | `isEmpty` `isNotEmpty` |
| **Values** | quoted string, number, `true`, `false`, `null` |

Details worth knowing:

- **One condition per edge.** For "A and B", use two edges.
- **Ordering comparisons are numeric.** `>` `<` `>=` `<=` against a non-number are
  false rather than guessing an order.
- **`contains`** works on arrays (membership) and strings (substring).
- **A missing field reads as absent**, not an error: `isEmpty` holds and every
  comparison is false. `== null` matches an absent field too.
- **An edge may only read its own source or a node upstream of it.** Reading anywhere
  else is a load error, because that output may not exist yet when the edge is evaluated.
- **Conditions are parsed at load time**, so a typo fails the run before it starts
  instead of becoming an edge that silently never fires.

## Settings

```yaml
settings:
  concurrency: 2       # 1–16, default 2 — max concurrent agent sessions
  model: claude-...    # optional run-wide default; per-node `model` wins
  budget:
    tokensPerNode: 300000
    tokensPerRun: 2000000
    minutesPerRun: 60
```

Only Worktree-Agent instances ever actually run in parallel, so `concurrency` matters
most in graphs that fan out.

### Budgets

Every budget field is optional, and unset means unbounded. Scaffolded workflows come
with real numbers, because "no ceiling" is a poor default for a workflow that can
retry.

| Field | Scope |
| --- | --- |
| `settings.budget.tokensPerNode` | Tokens one node may consume across all its attempts |
| `settings.budget.tokensPerRun` | Tokens the whole run may consume |
| `settings.budget.minutesPerRun` | Wall-clock minutes the whole run may take |
| `nodes[].budget.tokens` | Overrides `tokensPerNode` for that node alone |

A run-wide per-node ceiling has to be set for the most expensive node in the graph,
which leaves every cheap node effectively unbounded. The per-node override is how one
known-expensive step gets a limit that fits it.

**Tokens served from cache do not count against a budget.** A session re-sends its
cached prefix on every turn, so cache reads grow with how long a node has been
running rather than with how much work it has done — and they are billed at a
fraction of base input. Counting them made a ceiling a turn counter: a two-function
change was observed spending 154 fresh input tokens, 403 output tokens, and 2,077,069
cache reads, exhausting the scaffolded 2,000,000-token run budget before its tests
ever ran. Fresh input, output, and cache *writes* all count — a write is context
growing, which is the runaway a token ceiling should catch. For a node that spins
without growing its context, `minutesPerRun` is the backstop that fits.

Cards still show every token moved, cache included; only the budget draws the
distinction.

**A budget stop is final.** It never triggers a loop-back retry — retrying past a
ceiling is exactly what the ceiling exists to prevent.

## Named graphs

A file may declare more than one named graph instead of one flat `nodes`/`edges`
list, so a repo can carry several shapes of its process — a quick pass for a typo
fix, a heavily verified one for a risky change — in one reviewable file:

```yaml
settings: { ... }          # declared once — applies to whichever graph runs
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

`graphs:` and a top-level `nodes:`/`edges:` are mutually exclusive — a file
declaring both is rejected rather than resolved by guessing which one wins. Each
named graph is validated independently and in full, and a failure in one is
reported against that graph's name, never mistaken for a failure in another.

`settings` — budget included — is declared once, outside `graphs:`, and applies to
whichever graph a run selects. **A named graph cannot declare its own `budget`.**
A ceiling a shape gets to raise on its own behalf is not a ceiling: a `hardened`
graph that could grant itself more room than `quick` would make the run's maximum
cost a function of which shape was picked, after the file was already reviewed. A
graph that genuinely needs more room carries more nodes, each with its own
`nodes[].budget.tokens` — the same per-node override single-graph files already
have.

`flow-code run` resolves which graph it executes before any node starts: name one
explicitly with `--graph <name>`, or — in a terminal, with more than one
declared — you're asked, showing each name with its description. A file
declaring exactly one graph never asks. Without a terminal and without a name,
the run fails rather than guessing, listing the graphs the file declares. The
selected name is recorded on the run and shown in the header, in both `run` and
`watch`.

## Git worktrees

`worktree-agent` fans out N agent instances, each in its own git worktree and branch,
then converges by asking you which to keep. Because each instance has its own working
tree, parallel agents cannot collide in yours.

```yaml
  - id: explore
    type: worktree-agent
    config:
      mode: compare
      task: Add retry handling to the HTTP client
      instances:
        - { instructions: Prefer exponential backoff }
        - { instructions: Prefer a token bucket }
```

`mode: parallelize` instead gives each instance its own `task`, for independent work
that should not share a working tree.

## Approval before implementation

An `approval-gate` reads more than a diff. Placed directly downstream of a `spec`
node, it reads that node's file from disk and presents it as a document — rendered
as prose, not as a diff, so a spec's `- **AC1** — …` bullets read as acceptance
criteria rather than as deletions:

```yaml
nodes:
  - id: spec
    type: spec
  - id: spec-gate
    type: approval-gate
edges:
  - { from: spec, to: spec-gate }
```

No config: the document comes from the gate's direct dependencies, not from
anything you point it at. A gate downstream of more than one document-producing
node presents each, labelled with the node it came from; a gate with a diff and a
document presents both, on their own paths.

Rejecting the spec should reopen it, not end the run — a spec is rejected in order
to be rewritten. The scaffolded graph wires this as a bare loop-back straight from
the gate to the Discuss node upstream of `spec`:

```yaml
  - { from: spec-gate, to: discuss, loopback: true }
```

This looks unusual next to [loop-backs](#loop-backs) above — a loop-back normally
fires when its source *fails*, and a gate that got its answer never fails. It fires
here because a rejected gate is reported internally as though it had: `failure` is
the default trigger a bare `loopback: true` takes, and a rejected gate is the one
case that trigger is made to catch. It is not incidental — this predates rejection
branches on gates and is exactly the mechanism this relies on. An *approved* gate
never reports as a failure, so the same edge never fires on approval.

`discuss` — not `spec-gate` itself — is where it goes, because the gate has no way
to say *why* it was rejected; only a Discuss node can ask you. It resumes the same
conversation rather than starting cold, and tells you it is running again because
the work that followed it was sent back. `spec` reruns too, since it sits between
`discuss` and `spec-gate` in the reset segment, and rewrites the same file, so the
next pass reads what was actually approved.

This is deliberately not extended to the gate before Git-ops below: a spec is
rejected to be rewritten, but finished work is rejected to be abandoned, so that
gate keeps to the documented-but-not-enabled pattern its own section describes.

## Approval before git

The scaffolded graph puts an `approval-gate` between `review` and `git-ops`, so the
"nothing is pushed without explicit approval" guarantee holds with zero configuration.
The gate computes the pending diff against the run baseline and waits for a decision.

Both decisions finish the node — a gate that got its answer completed, so a rejection
is recorded as `decision: 'rejected'` rather than as a failure. What stops the branch
is the condition on the gate's out-edges: **an edge out of an `approval-gate` that
states no `when` is read as if it said `when: "<gate>.decision == 'approved'"`.** You
never write that yourself, and an edge that states its own condition is left alone. It
is why `- { from: gate, to: git-ops }` is safe exactly as written.

A rejected gate stops the run by default: no means stop. To send a rejection back for
another pass instead, either loop straight back:

```yaml
  - { from: gate, to: implement, loopback: { maxAttempts: 2 } }
```

...which retries carrying nothing but "a human said no" — or route the rejection
through a conversation first, so the retry knows what to change:

```yaml
nodes:
  - id: revise
    type: discuss
    config: { topic: what to change before this can be approved }
edges:
  - { from: gate, to: git-ops, when: "gate.decision == 'approved'" }
  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }
  - { from: revise, to: implement, loopback: { maxAttempts: 2, on: success } }
```

`revise` is an ordinary Discuss node — the same type the graph already starts with,
placed a second time. Node **ids** must be unique; types may repeat. It receives the
rejected diff through the gate (which is context-transparent), settles with you what
needs to change, and its recorded conclusion becomes the context `implement` retries
with. Each rejection costs an agent session, which is why the scaffolded graph ships
this commented out.

### Every git-writing node must be gated

The system SHALL validate — before execution, whether the workflow was hand-written or
scaffolded — that any node holding the `git-write` capability (built in, that is only
`git-ops`) is **dominated** by an `approval-gate`: every path from every root of the
graph to that node passes through one. It is not enough for *a* gate to be upstream —
a second path that reaches the git-writing node without passing any gate fails the
check just as an absent gate does:

```yaml
# rejected: `ship` is reachable via `impl -> ship` without passing `gate`,
# even though it's also reachable via `impl -> gate -> ship`.
edges:
  - { from: impl, to: gate }
  - { from: gate, to: ship }
  - { from: impl, to: ship }
```

A `when:` on that bypass edge does not save it — a path that *may* carry is a path
that may commit, so a conditional edge counts as present for this check. The check
keys on the `git-write` capability rather than the `git-ops` type id, so any future
node type granted that capability is covered automatically.

**There is no opt-out** — no settings key, no run flag, no headless auto-approve. An
unattended pipeline that needs to commit without a person answering a gate should
leave `git-ops` out of the graph entirely and commit from the pipeline itself once
`flow-code run` exits:

```yaml
# .flow-code/workflow.yaml — no git-ops node, so no gate is required
nodes:
  - { id: impl, type: implement, config: { instructions: ... } }
  - { id: check, type: test, config: { commands: ["..."] } }
edges:
  - { from: impl, to: check }
```

```bash
flow-code run && git add -A && git commit -m "..." && git push
```

An existing workflow file with a git-writing node that no gate dominates will fail to
load. The error names the node and the specific path that bypasses every gate; add an
`approval-gate` upstream of it, or remove the git-writing node as above.

`on: success` is what makes the branch work. A loop-back fires when its source ends
the way `on` names, and the default is `failure` — a failing test sends the run back,
a passing one does not. A revision step is the inverse: **finishing** it is the signal
to retry, so a return path waiting for it to fail would wait forever. See
[loop-backs](#loop-backs) for the field itself.

The loop returns to `implement` rather than to `discuss` on purpose: `spec` then stays
outside the reset segment, so every retry is judged against the same acceptance
criteria the first attempt was.

## Planning the graph

Every graph so far is fixed before the run starts — the shape you read is the shape
that executes. `flow-code init --preset planned` scaffolds a different kind of
file: just a spine.

```yaml
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: git-ops }
```

`plan` is interactive, like `discuss` — but where `discuss` settles what's being
built, `plan` settles that *and* proposes a graph to build it, drawn from the same
node types every other workflow uses. It doesn't complete until you accept a
proposal: push back on a draft ("skip Validate, this is a typo fix") and it revises;
end the session without accepting and the node errors, taking everything downstream
of it with it.

An accepted proposal is validated exactly as a hand-written file is — the same node
type, config, and structural checks, including [gate dominance](#every-git-writing-node-must-be-gated)
— before it's adopted. A proposal that fails is never spliced in; the failures go back
into the conversation as the next turn, so a rejected draft is a visible exchange, not
a silent retry. `plan` cannot propose a second `plan` node, or route a git-writing node
around `gate` — both are the same checks a person writing the file by hand would hit.

Once accepted, the proposed nodes are spliced in between `plan` and whatever it
pointed at — `gate`, above — and the run continues into them. The canvas grows to
show it; nothing about how those nodes execute differs from a node the file declared
directly.

At the end of a run that planned, you're offered the chance to keep the graph:
accepting writes the negotiated shape back to `.flow-code/workflow.yaml`, with `plan`
removed, as an ordinary static file. The next run skips planning — and spends no
tokens on it — unless you put `plan` back.

This is engine-path only. A run driven from a guest session records a rejection as a
failure and stops there; the rejection branch is not walked.

`git-ops` commits only. To push, configure a remote explicitly:

```yaml
  - id: git-ops
    type: git-ops
    config:
      push: { remote: origin, branch: my-branch }
```

### The commit message

With nothing configured, the node reads the staged diff and writes a
conventional-commit message describing what actually changed. Two ways to override
that, and they cannot be combined — a node carrying both fails to load:

```yaml
  - id: git-ops
    type: git-ops
    config:
      commitMessage: "chore: sync generated files"   # used exactly as written
```

```yaml
  - id: git-ops
    type: git-ops
    config:
      instructions: "Reference the ticket id in the subject line."   # how to write it
```

`commitMessage` is for a message you have already decided. `instructions` is for a
house style you want every commit to follow, with the wording left to the agent. For
anything longer than a sentence or two, attach a skill instead — `skills` works on
this node like any other, and a skill body is prepended ahead of the role prompt.
