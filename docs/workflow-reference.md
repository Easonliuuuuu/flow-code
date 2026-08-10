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

An edge declares structure, never behavior:

```yaml
edges:
  - { from: implement, to: test }
```

A node runs once every path into it has been resolved, and is given the recorded
outputs of the nodes it is wired to — and nothing else. Context follows the graph,
which is why an edge you did not draw is context a node does not get.

### Loop-backs

A loop-back is a return path: when `from` fails, execution resumes at `to` and
re-runs everything between them, with the failure passed in as context.

```yaml
  - { from: test, to: implement, loopback: true }               # 3 attempts (default)
  - { from: validate, to: implement, loopback: { maxAttempts: 5 } }
```

Whether a node failed is the node type's call, not the edge's — `validate` and
`review` fail on their own `fail` verdict, `test` on a non-zero exit status. The edge
only says where that failure routes.

`maxAttempts` is counted **on the target** and shared across every loop-back pointing
at it. Three loop-backs into `implement` at `maxAttempts: 3` give you three retries in
total, not nine — so a loop that never converges still terminates. After that the
failure stands and downstream nodes are skipped.

A loop-back cannot carry a `when:`. A return path is taken because its source failed,
and that is its condition.

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

## Approval before git

The scaffolded graph puts an `approval-gate` between `review` and `git-ops`, so the
"nothing is pushed without explicit approval" guarantee holds with zero configuration.
The gate computes the pending diff against the run baseline and waits for a decision.

A rejected gate deliberately has no loop-back: no means stop. To send a rejection back
for another pass instead, add one:

```yaml
  - { from: gate, to: implement, loopback: { maxAttempts: 2 } }
```

`git-ops` commits only. To push, configure a remote explicitly:

```yaml
  - id: git-ops
    type: git-ops
    config:
      push: { remote: origin, branch: my-branch }
```
