# What a run costs

The honest version, with the measurement it comes from.

## One real run

The default graph, run against this repository to make a small two-file change.
Eight nodes, six of which spend an agent session — Test and the gates spend
none. Nine minutes forty seconds, start to finish, including the time it spent
waiting for a human at both gates.

| | Tokens |
| --- | ---: |
| Fresh input | 278 |
| Output | 648 |
| Cache writes | 330,496 |
| Cache reads | 3,863,237 |
| **Total** | **4,194,659** |

Two things about that shape are worth reading twice, because they are what make
the headline number smaller than "4.2 million tokens" suggests:

**Almost all of it is cache.** A session re-sends its context on every turn, and
the same context is read back over and over. Cache reads bill at roughly a tenth
of base input, and cache writes at about a quarter more than base input, so the
4.2M total prices out nothing like 4.2M fresh tokens would.

**The model is doing far less writing than reading.** 648 output tokens across
six sessions. The expensive part of an agentic run is the context it carries,
not the code it emits.

## What that comes to

At first-party API list prices, for the same run:

| Model | Cost |
| --- | ---: |
| Claude Opus 5 | **~$4.00** |
| Claude Sonnet 5 | **~$2.40** |
| Claude Haiku 4.5 | **~$0.80** |

So: **a small change on the default graph costs a couple of dollars on a
mid-tier model.** A large change costs more, mostly in cache reads, because the
sessions run longer rather than because they write more.

Prices move; the token counts are what was measured. To reprice, multiply
against your provider's current rates — cache reads are the term that dominates.

## Where it goes to zero

If you are logged into the `claude` or `codex` CLI, flow-code uses that login,
and the run draws on that subscription rather than metered API billing. There is
no per-run charge at all. `flow-code init` looks for exactly this before it asks
you for a key, and starts the picker on it when it finds one — for most people
this is the answer, and the table above is the answer for everyone else.

`flow-code try` costs nothing under any configuration: every session in it is
scripted, and no provider is contacted.

## Making it cheaper

Roughly in order of how much they save:

**Use the `frugal` preset.** `flow-code init --preset frugal` scaffolds the same
graph with the expensive parts removed: no Review node (one fewer session, and
one fewer full read of the diff), `subagents: false`, tighter budgets, and one
fewer retry on each loop-back. It keeps both approval gates and the exit-code
verdict — frugal means fewer and smaller sessions, not less of a say in what
reaches git.

**Turn off delegation.** `settings.subagents: false` on any graph. A subagent
re-establishes its own context from scratch, so it is the single largest
multiplier on a session's token count.

**Put a cheap model on the cheap steps.** Spec, Validate and Git-ops summarize,
check, and write a commit message against material that is already written down.
Implement is the step worth paying for. Set `model:` per node in
`workflow.yaml`, or press `m` on a focused node mid-run.

**Set a ceiling and mean it.** `settings.budget.tokensPerRun` stops a run rather
than warning about it. Cache reads are excluded from the count, so the number
tracks context growth rather than elapsed turns — see
[Budgets](workflow-reference.md#budgets).

**Drop nodes you are not reading.** Every node in the scaffolded graph is
optional. If you never read the Review output because you read the diff at the
gate anyway, delete the node.

## Is it worth it?

Against asking your coding agent directly and reviewing what it did, flow-code
spends more tokens for structure: a written spec that outlives the prompt, a
verdict that is an exit code rather than an opinion, a bounded retry when that
verdict fails, two points where you say yes or no, and a record of what actually
happened.

That trade is worth it when a change is big enough that you would otherwise lose
track of it, or consequential enough that you want the gates. It is not worth it
for a typo. Nothing about the tool assumes you use it for everything.
